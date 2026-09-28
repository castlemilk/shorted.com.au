package mcp

import (
	"context"
	"fmt"
	"strings"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/strategies"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// Strategy picks: named stock-picking methods (Zanger, CAN SLIM, Minervini,
// and two house strategies: a crowded-short breakout and quality compounders)
// evaluated daily over price structure, reported fundamentals, the quality
// ratios behind them and ASIC short interest. See docs/plans/stock-picker.md
// §5 and docs/plans/fundamentals-coverage.md §8.
//
// Two tools, discovery-shaped like screen_stocks: list_strategies says what
// exists and what the market backdrop is, get_strategy_picks returns one
// strategy's ranked shortlist with a per-rule verdict for every stock.
//
// Two things shape the projections here.
//
// ZERO IS NOT A READING. Emitting a 0 for a figure the source never measured
// is the screener's old defect again (a model reads "pivot 0" as a price), so
// every numeric field is a pointer that is absent when the source said
// nothing. Where the proto carries a has_* flag the flag decides, so a
// measured zero survives: growth, close, 3-month relative strength (exactly in
// line with the index) and short percent (an ASIC row reporting no position).
// The base fields (pivot, base depth, volume ratio) have no flag: the handler
// dereferences a NULL feature to 0 and none of them is legitimately 0, so a
// zero there still reads as unknown.
//
// THE PER-RULE EVIDENCE IS WHAT BLOWS THE BUDGET. A pick carries 6-7 rule
// results, each with an evidence sentence of up to ~200 characters. At the
// 25-pick ceiling, in the worst case (watch-status stocks that fail most
// rules), that is over 20KB of evidence alone against a 16KB per-call budget,
// and the 25 rows cost ~12KB before any of it. So rule OUTCOMES are always
// complete — passed / failed / unknown id lists on every pick, ~14 bytes a
// rule where an {id, status, detail} object costs ~36 before its detail — and
// the evidence sentences are spent in rank order from a fixed byte allowance,
// with detail_trimmed saying when it ran out. The top of the list, which is
// what a reader acts on, always carries its evidence.
//
// A pick also carries two quality ratios (return on equity, net margin) and
// where its growth figures came from (fundamentals_source: "filing" when
// either growth figure was read from a parsed ASX filing). Those ~70 bytes a
// row were paid for out of the evidence allowance (2,500 to 1,500 bytes), not
// by raising the budget.

const (
	defaultStrategyPicksLimit = 10

	// maxStrategyPicksLimit is far inside the handler's 100. A strategy's
	// value is a SHORT list — concentration is one of Zanger's rules — and 25
	// worst-case rows with complete rule outcomes measure 12.5KB of the 16KB
	// per-call budget before any evidence.
	maxStrategyPicksLimit = 25

	// maxRuleEvidenceChars bounds one evidence sentence. Most run 40-110
	// characters; the longest (growth with acceleration on both series, or a
	// base failing three tests at once) runs past 200.
	maxRuleEvidenceChars = 120

	// maxPickEvidenceBytes is the evidence allowance for one result, spent in
	// rank order. Sized so the worst case at the 25-pick ceiling, every row
	// carrying its quality ratios and fundamentals source, stays inside the
	// 16KB per-call budget (payload_budget_test.go). It is ~12 sentences at
	// their cap and far more at their usual length; triggered and setup rows
	// fail one to three rules each, so a default call over those carries all
	// of its evidence.
	maxPickEvidenceBytes = 1500
)

// strategyIDs lists the registry's strategy ids, for validation and for the
// error a model reads when it guesses one.
func strategyIDs() []string {
	var ids []string
	for _, st := range strategies.Registry() {
		ids = append(ids, st.ID)
	}
	return ids
}

// MarketRegimeSummary is shared by both strategy tools. The SDK inlines it at
// each use site, so it stays four fields.
type MarketRegimeSummary struct {
	IndexCode string `json:"index_code"`
	AsOf      string `json:"as_of,omitempty"`
	Regime    string `json:"regime,omitempty" jsonschema:"uptrend, neutral or downtrend; absent when unknown."`
	Verdict   string `json:"verdict,omitempty"`
}

func projectRegime(r *shortsv1alpha1.MarketRegime) MarketRegimeSummary {
	return MarketRegimeSummary{
		IndexCode: nonEmpty(r.GetIndexCode(), strategies.DefaultIndexCode),
		AsOf:      r.GetAsOf(),
		Regime:    r.GetRegime(),
		Verdict:   r.GetVerdict(),
	}
}

// ---------------------------------------------------------------------------
// list_strategies
// ---------------------------------------------------------------------------

// ListStrategiesInput is empty: there are five strategies and one regime, and
// a filter would be a round trip for nothing.
type ListStrategiesInput struct{}

type StrategyRuleSummary struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Core  bool   `json:"core"`
}

type StrategySummary struct {
	ID            string                `json:"id"`
	Name          string                `json:"name"`
	Author        string                `json:"author"`
	Tagline       string                `json:"tagline"`
	Style         string                `json:"style,omitempty"`
	HoldingPeriod string                `json:"holding_period,omitempty"`
	Rules         []StrategyRuleSummary `json:"rules"`
}

type ListStrategiesOutput struct {
	Count      int                 `json:"count"`
	Strategies []StrategySummary   `json:"strategies"`
	Regime     MarketRegimeSummary `json:"regime"`
}

const listStrategiesDescription = "The named stock-picking strategies evaluated daily over ASX stocks: Zanger Breakout " +
	"(Dan Zanger), CAN SLIM (William O'Neil), Minervini Trend Template (Mark Minervini), and Shorted's own Crowded-Short " +
	"Breakout (on ASIC short interest) and Quality compounders (return on equity, margins, cash conversion and debt from " +
	"reported statements), each with author, summary, style, holding period and rules, marked core or not: every core " +
	"rule must pass for a stock to be triggered. Also the current S&P/ASX 200 market regime. Call get_strategy_picks " +
	"next with an id for the ranked stocks. A rules-based screen over end-of-day data, not financial advice. Takes no " +
	"arguments."

func listStrategiesTool() Tool {
	tool := Tool{
		Name:        "list_strategies",
		Title:       "List stock-picking strategies",
		Description: listStrategiesDescription,
		RPC:         "shorts.v1alpha1.StrategyService.ListStrategies",
		Domain:      "discovery",
	}
	tool.register = func(server *sdk.Server, src DataSource) {
		sdk.AddTool(server, tool.spec(), listStrategiesHandler(src))
	}
	return tool
}

func listStrategiesHandler(src DataSource) sdk.ToolHandlerFor[ListStrategiesInput, ListStrategiesOutput] {
	return func(ctx context.Context, _ *sdk.CallToolRequest, _ ListStrategiesInput) (*sdk.CallToolResult, ListStrategiesOutput, error) {
		res, err := src.ListStrategies(ctx, connect.NewRequest(&shortsv1alpha1.ListStrategiesRequest{}))
		if err != nil {
			return nil, ListStrategiesOutput{}, fmt.Errorf("could not list strategies: %w", err)
		}
		if res == nil || res.Msg == nil {
			return nil, ListStrategiesOutput{}, fmt.Errorf("no strategies returned")
		}

		// Projected: the proto also carries each strategy's description
		// paragraphs, the author's rule text, our evaluation prose, caveats and
		// sources — several KB per strategy, and the page at
		// shorted.com.au/picks/{id} is the place to read them.
		out := ListStrategiesOutput{
			Strategies: []StrategySummary{},
			Regime:     projectRegime(res.Msg.GetRegime()),
		}
		for _, st := range res.Msg.GetStrategies() {
			if st == nil {
				continue
			}
			row := StrategySummary{
				ID:            st.GetId(),
				Name:          st.GetName(),
				Author:        st.GetAuthor(),
				Tagline:       st.GetTagline(),
				Style:         st.GetMetadata().GetStyle(),
				HoldingPeriod: st.GetMetadata().GetHoldingPeriod(),
				Rules:         []StrategyRuleSummary{},
			}
			for _, r := range st.GetRules() {
				if r == nil {
					continue
				}
				row.Rules = append(row.Rules, StrategyRuleSummary{ID: r.GetId(), Title: r.GetTitle(), Core: r.GetCore()})
			}
			out.Strategies = append(out.Strategies, row)
		}
		out.Count = len(out.Strategies)

		var text string
		if out.Count == 0 {
			text = "No strategies are available."
		} else {
			ids := make([]string, 0, out.Count)
			for _, st := range out.Strategies {
				ids = append(ids, st.ID)
			}
			text = fmt.Sprintf("%d strategies: %s. %s Call get_strategy_picks with one of these ids for its ranked stocks. "+
				"Full rules and method: https://shorted.com.au/picks. Not financial advice.",
				out.Count, strings.Join(ids, ", "), describeRegime(out.Regime))
		}
		return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: text}}}, out, nil
	}
}

// describeRegime renders the regime for a text fallback.
func describeRegime(r MarketRegimeSummary) string {
	if r.Regime == "" {
		return nonEmpty(r.Verdict, "Market regime unavailable.")
	}
	s := fmt.Sprintf("Regime %s", r.Regime)
	if r.AsOf != "" {
		s += " as at " + r.AsOf
	}
	if r.Verdict != "" {
		s += " (" + strings.TrimSuffix(r.Verdict, ".") + ")"
	}
	return s + "."
}

// ---------------------------------------------------------------------------
// get_strategy_picks
// ---------------------------------------------------------------------------

type GetStrategyPicksInput struct {
	StrategyID string `json:"strategy_id" jsonschema:"zanger-breakout, canslim, minervini-trend-template, crowded-short-breakout or quality-compounders. Required."`
	Status     string `json:"status,omitempty" jsonschema:"triggered, setup or watch. Omit for all."`
	SortBy     string `json:"sort_by,omitempty" jsonschema:"score (default), revenue_yoy, eps_yoy, roe, net_margin, fcf_margin, pe (lowest first) or market_cap; unknowns last."`
	Limit      int    `json:"limit,omitempty" jsonschema:"1-25, default 10."`
}

type StrategyHeader struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Author  string `json:"author"`
	Tagline string `json:"tagline,omitempty"`
}

// StrategyPickRow is one ranked stock. Every numeric pointer is absent when
// unknown — see the file comment.
type StrategyPickRow struct {
	Rank               int               `json:"rank" jsonschema:"Across all statuses."`
	Code               string            `json:"code"`
	Name               string            `json:"name,omitempty"`
	Industry           string            `json:"industry,omitempty"`
	Status             string            `json:"status"`
	Score              float64           `json:"score" jsonschema:"0-100."`
	Close              *float64          `json:"close,omitempty" jsonschema:"AUD."`
	Pivot              *float64          `json:"pivot,omitempty" jsonschema:"AUD."`
	BaseDepthPct       *float64          `json:"base_depth_pct,omitempty"`
	BaseLengthDays     int               `json:"base_length_days,omitempty" jsonschema:"Sessions."`
	VolumeRatio50D     *float64          `json:"volume_ratio_50d,omitempty"`
	RevenueYoYPct      *float64          `json:"revenue_yoy_pct,omitempty"`
	EPSYoYPct          *float64          `json:"eps_yoy_pct,omitempty"`
	RS3MPct            *float64          `json:"rs_3m_pct,omitempty" jsonschema:"Percentage points."`
	ShortPct           *float64          `json:"short_pct,omitempty"`
	ROEPct             *float64          `json:"roe_pct,omitempty"`
	NetMarginPct       *float64          `json:"net_margin_pct,omitempty"`
	FundamentalsSource string            `json:"fundamentals_source,omitempty" jsonschema:"filing when a growth figure came from a parsed ASX filing, else vendor."`
	Passed             []string          `json:"passed,omitempty"`
	Failed             []string          `json:"failed,omitempty"`
	Unknown            []string          `json:"unknown,omitempty" jsonschema:"Data missing; never counts as a pass."`
	Evidence           map[string]string `json:"evidence,omitempty" jsonschema:"By rule id, for failed and unknown rules."`
}

type GetStrategyPicksOutput struct {
	Strategy                  StrategyHeader      `json:"strategy"`
	Regime                    MarketRegimeSummary `json:"regime"`
	AsOf                      string              `json:"as_of,omitempty" jsonschema:"Latest price date."`
	UniverseCount             int                 `json:"universe_count"`
	FundamentalsRowsCount     int                 `json:"fundamentals_rows_count" jsonschema:"Evaluated stocks with any reported fundamentals."`
	FundamentalsCoverageCount int                 `json:"fundamentals_coverage_count" jsonschema:"Of those, with a growth figure."`
	TotalCount                int                 `json:"total_count" jsonschema:"Before the limit."`
	Count                     int                 `json:"count"`
	DetailTrimmed             bool                `json:"detail_trimmed,omitempty" jsonschema:"Evidence ran out part-way down the list."`
	Picks                     []StrategyPickRow   `json:"picks"`
}

const getStrategyPicksDescription = "Ranked ASX stocks for one named strategy, with every rule's outcome (passed, failed, " +
	"unknown) and evidence for the failures. Status: triggered (every core rule passes), setup (all but the trigger, " +
	"usually the breakout: the watchlist) or watch (some rules pass); ranked by status, then score, or reordered by " +
	"sort_by (rank stays the strategy's). Each pick carries close, pivot (the base high: the breakout level, and where " +
	"a failed breakout falls back through), base depth and length in sessions, volume over its 50-day average, revenue " +
	"and EPS growth year on year, return on equity and net margin, 3-month return relative to the S&P/ASX 200 and ASIC " +
	"short percent; a figure is absent when unknown, never zero. Also the market regime with this strategy's verdict " +
	"(a downtrend means stand aside, it does not hide picks) and how many evaluated stocks hold fundamentals: without " +
	"them fundamentals rules read unknown and a stock cannot trigger. Default 10 picks, maximum 25. Ids and rules: " +
	"list_strategies. A pick's statements and ratios: get_stock_fundamentals. End-of-day data; short data is T+4. A " +
	"rules-based screen, not financial advice."

func getStrategyPicksTool() Tool {
	tool := Tool{
		Name:        "get_strategy_picks",
		Title:       "Get a strategy's ranked stock picks",
		Description: getStrategyPicksDescription,
		RPC:         "shorts.v1alpha1.StrategyService.GetStrategyPicks",
		Domain:      "discovery",
	}
	tool.register = func(server *sdk.Server, src DataSource) {
		sdk.AddTool(server, tool.spec(), getStrategyPicksHandler(src))
	}
	return tool
}

func getStrategyPicksHandler(src DataSource) sdk.ToolHandlerFor[GetStrategyPicksInput, GetStrategyPicksOutput] {
	return func(ctx context.Context, _ *sdk.CallToolRequest, in GetStrategyPicksInput) (*sdk.CallToolResult, GetStrategyPicksOutput, error) {
		id := strings.ToLower(strings.TrimSpace(in.StrategyID))
		if id == "" {
			return nil, GetStrategyPicksOutput{}, fmt.Errorf(
				"strategy_id is required: use one of %s, or call list_strategies", strings.Join(strategyIDs(), ", "))
		}
		if _, ok := strategies.Lookup(id); !ok {
			return nil, GetStrategyPicksOutput{}, fmt.Errorf(
				"%q is not a strategy id: use one of %s", in.StrategyID, strings.Join(strategyIDs(), ", "))
		}
		status := strings.ToLower(strings.TrimSpace(in.Status))
		if status != "" && !strategies.ValidPickStatus(status) {
			return nil, GetStrategyPicksOutput{}, fmt.Errorf(
				"%q is not a pick status: use triggered, setup or watch, or omit it for all", in.Status)
		}
		// Validated against the evaluator's own closed set, so a typo is a
		// message naming the choices rather than an InvalidArgument to decode.
		sortBy := strings.ToLower(strings.TrimSpace(in.SortBy))
		if sortBy != "" && !strategies.ValidSortBy(sortBy) {
			return nil, GetStrategyPicksOutput{}, fmt.Errorf(
				"%q is not a sort_by value: use one of %s, or omit it for rank order", in.SortBy, strings.Join(strategies.SortKeys(), ", "))
		}
		limit := clampLimit(in.Limit, defaultStrategyPicksLimit, maxStrategyPicksLimit)

		res, err := src.GetStrategyPicks(ctx, connect.NewRequest(&shortsv1alpha1.GetStrategyPicksRequest{
			StrategyId: id,
			Status:     status,
			SortBy:     sortBy,
			Limit:      limit,
		}))
		if err != nil {
			return nil, GetStrategyPicksOutput{}, fmt.Errorf("could not get picks for %s: %w", id, err)
		}
		if res == nil || res.Msg == nil {
			return nil, GetStrategyPicksOutput{}, fmt.Errorf("no data returned for strategy %s", id)
		}

		msg := res.Msg
		st := msg.GetStrategy()
		out := GetStrategyPicksOutput{
			Strategy: StrategyHeader{
				ID:      nonEmpty(st.GetId(), id),
				Name:    nonEmpty(st.GetName(), id),
				Author:  st.GetAuthor(),
				Tagline: st.GetTagline(),
			},
			Regime:                    projectRegime(msg.GetRegime()),
			AsOf:                      msg.GetAsOf(),
			UniverseCount:             int(msg.GetUniverseCount()),
			FundamentalsRowsCount:     int(msg.GetFundamentalsRowsCount()),
			FundamentalsCoverageCount: int(msg.GetFundamentalsCoverageCount()),
			TotalCount:                int(msg.GetTotalCount()),
			Picks:                     []StrategyPickRow{},
		}

		evidenceLeft := maxPickEvidenceBytes
		for _, p := range msg.GetPicks() {
			if p == nil {
				continue
			}
			row := projectPick(p)
			for _, r := range p.GetRules() {
				if r == nil || r.GetStatus() == "pass" {
					continue
				}
				detail := truncate(strings.TrimSpace(r.GetDetail()), maxRuleEvidenceChars)
				if detail == "" {
					continue
				}
				// Charged at its encoded cost: key, quotes, colon, comma.
				cost := len(r.GetRuleId()) + len(detail) + 6
				if cost > evidenceLeft {
					out.DetailTrimmed = true
					continue
				}
				evidenceLeft -= cost
				if row.Evidence == nil {
					row.Evidence = map[string]string{}
				}
				row.Evidence[r.GetRuleId()] = detail
			}
			out.Picks = append(out.Picks, row)
			// The handler pages, but a backend that ignored the limit must not
			// be able to push this past the budget it was sized for.
			if len(out.Picks) == int(limit) {
				break
			}
		}
		out.Count = len(out.Picks)

		return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: describePicks(out, status, sortBy, st)}}}, out, nil
	}
}

// projectPick narrows a StrategyPick to the published fields. The proto also
// carries a logo URL, market cap, per-rule numeric values that duplicate the
// headline figures and a fundamentals block whose other ratios and periods
// get_stock_fundamentals publishes in full; none change what a reader of a
// ranked list concludes.
func projectPick(p *shortsv1alpha1.StrategyPick) StrategyPickRow {
	f := p.GetFundamentals()
	row := StrategyPickRow{
		Rank:           int(p.GetRank()),
		Code:           p.GetStockCode(),
		Name:           p.GetCompanyName(),
		Industry:       p.GetIndustry(),
		Status:         p.GetStatus(),
		Score:          finite(p.GetScore()),
		Close:          optionalFloat(p.GetClose(), p.GetHasClose()),
		Pivot:          knownFloat(p.GetPivot()),
		BaseDepthPct:   knownRounded(p.GetBaseDepthPct()),
		BaseLengthDays: int(p.GetBaseLengthDays()),
		VolumeRatio50D: knownRounded(p.GetVolumeRatio_50D()),
		RevenueYoYPct:  roundedOptional(p.GetRevenueYoyPct(), p.GetHasRevenueYoy()),
		EPSYoYPct:      roundedOptional(p.GetEpsYoyPct(), p.GetHasEpsYoy()),
		RS3MPct:        roundedOptional(p.GetRs_3MPct(), p.GetHasRs_3MPct()),
		ShortPct:       roundedOptional(p.GetShortPct(), p.GetHasShortPct()),
		// The API has already withheld what is not meaningful for a financial
		// (ROE and net margin never are); a flag, not the value, decides.
		ROEPct:             roundedOptional(f.GetRoePct(), f.GetHasRoePct()),
		NetMarginPct:       roundedOptional(f.GetNetMarginPct(), f.GetHasNetMarginPct()),
		FundamentalsSource: pickFundamentalsSource(f),
	}
	if row.BaseLengthDays < 0 {
		row.BaseLengthDays = 0
	}
	for _, r := range p.GetRules() {
		if r == nil || r.GetRuleId() == "" {
			continue
		}
		switch r.GetStatus() {
		case "pass":
			row.Passed = append(row.Passed, r.GetRuleId())
		case "fail":
			row.Failed = append(row.Failed, r.GetRuleId())
		default:
			// Anything the evaluator did not call a pass or a fail is not a
			// pass: unknown is the honest bucket for it.
			row.Unknown = append(row.Unknown, r.GetRuleId())
		}
	}
	return row
}

// Basis sources, as mv_fundamentals_growth names them (plan
// fundamentals-coverage.md §2.6).
const (
	basisSourceFiling = "filing"
	basisSourceVendor = "vendor"
)

// pickFundamentalsSource says where a pick's growth figures came from:
// "filing" when either the revenue or the EPS figure was computed from a row
// parsed out of an ASX filing, "vendor" when the figures it has are all the
// market data provider's, and absent when neither figure carries a source (no
// growth figure, or an API from before the basis sources existed). Absent is
// not a status.
func pickFundamentalsSource(f *shortsv1alpha1.PickFundamentals) string {
	rev, eps := f.GetRevenueBasisSource(), f.GetEpsBasisSource()
	switch {
	case rev == basisSourceFiling || eps == basisSourceFiling:
		return basisSourceFiling
	case rev == basisSourceVendor || eps == basisSourceVendor:
		return basisSourceVendor
	}
	return ""
}

// usesFundamentals reads the strategy's own rule list from the response, so the
// zero-picks explanation follows what the server evaluated.
func usesFundamentals(st *shortsv1alpha1.Strategy) bool {
	for _, r := range st.GetRules() {
		if r.GetDataSource() == strategies.SourceFundamentals {
			return true
		}
	}
	return false
}

// fundamentalsRuleKind names the rules a missing fundamentals row leaves
// unknown: the quality ratios for a strategy built on them, the growth figures
// otherwise. Read from the registry, which is what the server evaluated.
func fundamentalsRuleKind(id string) string {
	if st, ok := strategies.Lookup(id); ok && st.UsesQualityRules() {
		return "quality"
	}
	return "growth"
}

// describeSort says how a sorted list is ordered, "" in rank order. Three
// sort figures (free-cash-flow margin, P/E, market cap) are not columns of a
// pick row, so the sentence says where to read them rather than leave a list
// ordered by a number the reader cannot see. Market cap is the picker's
// resolved figure: our close times shares on issue (get_stock_fundamentals'
// market_cap), else the screener's where we hold no share count, which
// get_stock_fundamentals does not carry, so the sentence says so.
func describeSort(sortBy string) string {
	var s string
	switch sortBy {
	case "", strategies.SortScore:
		return ""
	case strategies.SortPE:
		s = " Sorted by pe, lowest first, unknowns last; rank is still the strategy's."
	default:
		s = " Sorted by " + sortBy + ", highest first, unknowns last; rank is still the strategy's."
	}
	switch sortBy {
	case strategies.SortFCFMargin, strategies.SortPE:
		s += " Each stock's " + sortBy + " figure is in get_stock_fundamentals."
	case strategies.SortMarketCap:
		s += " Market cap is the latest close x shares on issue, in AUD (get_stock_fundamentals' market_cap), " +
			"or the screener's figure where we hold no share count."
	}
	return s
}

// describeCoverage is the coverage sentence. It quotes fundamentals_rows_count
// only when the API supplies one that can contain the growth count (the web's
// rule, plan §7.2); an older API's absent count is not "0 of N".
func describeCoverage(out GetStrategyPicksOutput, kind string) string {
	if out.FundamentalsRowsCount > 0 && out.FundamentalsRowsCount >= out.FundamentalsCoverageCount {
		return fmt.Sprintf(" Fundamentals held for %d of %d stocks evaluated (growth figures for %d); without them the %s rules read unknown.",
			out.FundamentalsRowsCount, out.UniverseCount, out.FundamentalsCoverageCount, kind)
	}
	return fmt.Sprintf(" Fundamentals cover %d of %d stocks evaluated; without them the %s rules read unknown.",
		out.FundamentalsCoverageCount, out.UniverseCount, kind)
}

func describePicks(out GetStrategyPicksOutput, status, sortBy string, st *shortsv1alpha1.Strategy) string {
	name := out.Strategy.Name
	kind := fundamentalsRuleKind(out.Strategy.ID)
	var b strings.Builder
	if out.Count == 0 {
		b.WriteString("No picks for " + name)
		if status != "" {
			b.WriteString(" with status " + status)
		}
		b.WriteString(".")
		switch {
		case out.UniverseCount == 0:
			b.WriteString(" The evaluation universe is empty: price features have not been computed yet, so no stock could be evaluated.")
		case usesFundamentals(st) && kind == "growth" && out.FundamentalsCoverageCount == 0 && out.FundamentalsRowsCount > 0:
			fmt.Fprintf(&b, " None of the %d stocks evaluated has a growth figure yet (%d hold reported fundamentals), so the growth rules read unknown and cannot pass.",
				out.UniverseCount, out.FundamentalsRowsCount)
		case usesFundamentals(st) && out.FundamentalsCoverageCount == 0 && out.FundamentalsRowsCount == 0:
			fmt.Fprintf(&b, " None of the %d stocks evaluated has reported fundamentals yet, so the %s rules read unknown and cannot pass.", out.UniverseCount, kind)
		case status != "":
			fmt.Fprintf(&b, " %d stocks were evaluated; omit the status filter to see the rest of the ladder.", out.UniverseCount)
		default:
			fmt.Fprintf(&b, " %d stocks were evaluated and none passed any rule.", out.UniverseCount)
		}
		b.WriteString(" " + describeRegime(out.Regime))
		return b.String()
	}

	triggered, setup := 0, 0
	for _, p := range out.Picks {
		switch p.Status {
		case "triggered":
			triggered++
		case "setup":
			setup++
		}
	}
	fmt.Fprintf(&b, "%d picks for %s: %d triggered, %d setup", out.Count, name, triggered, setup)
	if out.TotalCount > out.Count {
		fmt.Fprintf(&b, " (of %d matching)", out.TotalCount)
	}
	b.WriteString(".")
	b.WriteString(describeSort(sortBy))
	b.WriteString(" " + describeRegime(out.Regime))

	first := out.Picks[0]
	fmt.Fprintf(&b, " First: %s (%s), %s, score %.1f", first.Code, nonEmpty(first.Name, "name unknown"), first.Status, first.Score)
	if first.Pivot != nil {
		fmt.Fprintf(&b, ", pivot A$%.2f", *first.Pivot)
	}
	b.WriteString(".")
	if usesFundamentals(st) && out.UniverseCount > 0 {
		b.WriteString(describeCoverage(out, kind))
	}
	if out.DetailTrimmed {
		b.WriteString(" Evidence was trimmed further down the list; ask for fewer picks or a single status to see all of it.")
	}
	if out.AsOf != "" {
		b.WriteString(" Prices to " + out.AsOf + ".")
	}
	b.WriteString(" Method: https://shorted.com.au/picks/" + out.Strategy.ID + ". Not financial advice.")
	return b.String()
}
