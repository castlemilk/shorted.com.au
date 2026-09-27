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
// and a house crowded-short breakout) evaluated daily over price structure,
// reported fundamentals and ASIC short interest. See
// docs/plans/stock-picker.md §5.
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
	// rank order. Sized so the worst case at the 25-pick ceiling measures
	// ~14.6KB against the 16KB per-call budget (payload_budget_test.go). It is
	// ~20 sentences at their cap and far more at their usual length; triggered
	// and setup rows fail one to three rules each, so a default call over
	// those carries all of its evidence.
	maxPickEvidenceBytes = 2500
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

// ListStrategiesInput is empty: there are four strategies and one regime, and
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

const listStrategiesDescription = "The named stock-picking strategies evaluated daily over ASX stocks — Zanger Breakout " +
	"(Dan Zanger), CAN SLIM (William O'Neil), Minervini Trend Template (Mark Minervini) and Crowded-Short Breakout " +
	"(Shorted's own, on ASIC short interest) — each with author, summary, style, holding period and rules, marked core " +
	"or not: every core rule must pass for a stock to be triggered. Also the current S&P/ASX 200 market regime. " +
	"Call get_strategy_picks next with an id for the ranked stocks. A rules-based screen over end-of-day data, not " +
	"financial advice. Takes no arguments."

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
	StrategyID string `json:"strategy_id" jsonschema:"zanger-breakout, canslim, minervini-trend-template or crowded-short-breakout. Required."`
	Status     string `json:"status,omitempty" jsonschema:"triggered, setup or watch. Omit for all."`
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
	Rank           int               `json:"rank" jsonschema:"Across all statuses."`
	Code           string            `json:"code"`
	Name           string            `json:"name,omitempty"`
	Industry       string            `json:"industry,omitempty"`
	Status         string            `json:"status"`
	Score          float64           `json:"score" jsonschema:"0-100."`
	Close          *float64          `json:"close,omitempty" jsonschema:"AUD."`
	Pivot          *float64          `json:"pivot,omitempty" jsonschema:"AUD."`
	BaseDepthPct   *float64          `json:"base_depth_pct,omitempty"`
	BaseLengthDays int               `json:"base_length_days,omitempty" jsonschema:"Sessions."`
	VolumeRatio50D *float64          `json:"volume_ratio_50d,omitempty"`
	RevenueYoYPct  *float64          `json:"revenue_yoy_pct,omitempty"`
	EPSYoYPct      *float64          `json:"eps_yoy_pct,omitempty"`
	RS3MPct        *float64          `json:"rs_3m_pct,omitempty" jsonschema:"Percentage points."`
	ShortPct       *float64          `json:"short_pct,omitempty"`
	Passed         []string          `json:"passed,omitempty"`
	Failed         []string          `json:"failed,omitempty"`
	Unknown        []string          `json:"unknown,omitempty" jsonschema:"Data missing; never counts as a pass."`
	Evidence       map[string]string `json:"evidence,omitempty" jsonschema:"By rule id, for failed and unknown rules."`
}

type GetStrategyPicksOutput struct {
	Strategy                  StrategyHeader      `json:"strategy"`
	Regime                    MarketRegimeSummary `json:"regime"`
	AsOf                      string              `json:"as_of,omitempty" jsonschema:"Latest price date."`
	UniverseCount             int                 `json:"universe_count"`
	FundamentalsCoverageCount int                 `json:"fundamentals_coverage_count"`
	TotalCount                int                 `json:"total_count" jsonschema:"Before the limit."`
	Count                     int                 `json:"count"`
	DetailTrimmed             bool                `json:"detail_trimmed,omitempty" jsonschema:"Evidence ran out part-way down the list."`
	Picks                     []StrategyPickRow   `json:"picks"`
}

const getStrategyPicksDescription = "Ranked ASX stocks for one named strategy, with every rule's outcome (passed, failed, " +
	"unknown) and evidence for the failures. Status: triggered (every core rule passes), setup (all but the trigger, " +
	"usually the breakout: the watchlist) or watch (some rules pass); ranked by status, then score. Each pick carries " +
	"close, pivot (the base high: the breakout level, and where a failed breakout falls back through), base depth and " +
	"length in sessions, volume over its 50-day average, revenue and EPS growth year on year, 3-month return relative " +
	"to the S&P/ASX 200 and ASIC short percent; a figure is absent when unknown, never zero. Also the market regime " +
	"with this strategy's verdict (a downtrend means stand aside, it does not hide picks) and how many evaluated stocks " +
	"have reported fundamentals: without them growth rules read unknown and a stock cannot trigger. Default 10 picks, " +
	"maximum 25. Ids and rules: list_strategies. A pick's reported periods: get_stock_fundamentals. End-of-day data; " +
	"short data is T+4. A rules-based screen, not financial advice."

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
		limit := clampLimit(in.Limit, defaultStrategyPicksLimit, maxStrategyPicksLimit)

		res, err := src.GetStrategyPicks(ctx, connect.NewRequest(&shortsv1alpha1.GetStrategyPicksRequest{
			StrategyId: id,
			Status:     status,
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

		return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: describePicks(out, status, st)}}}, out, nil
	}
}

// projectPick narrows a StrategyPick to the published fields. The proto also
// carries a logo URL, market cap and per-rule numeric values that duplicate the
// headline figures; none change what a reader concludes.
func projectPick(p *shortsv1alpha1.StrategyPick) StrategyPickRow {
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

func describePicks(out GetStrategyPicksOutput, status string, st *shortsv1alpha1.Strategy) string {
	name := out.Strategy.Name
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
		case usesFundamentals(st) && out.FundamentalsCoverageCount == 0:
			b.WriteString(fmt.Sprintf(" None of the %d stocks evaluated has reported fundamentals yet, so the growth rules read unknown and cannot pass.", out.UniverseCount))
		case status != "":
			b.WriteString(fmt.Sprintf(" %d stocks were evaluated; omit the status filter to see the rest of the ladder.", out.UniverseCount))
		default:
			b.WriteString(fmt.Sprintf(" %d stocks were evaluated and none passed any rule.", out.UniverseCount))
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
	b.WriteString(fmt.Sprintf("%d picks for %s: %d triggered, %d setup", out.Count, name, triggered, setup))
	if out.TotalCount > out.Count {
		b.WriteString(fmt.Sprintf(" (of %d matching)", out.TotalCount))
	}
	b.WriteString(". " + describeRegime(out.Regime))

	first := out.Picks[0]
	b.WriteString(fmt.Sprintf(" First: %s (%s), %s, score %.1f", first.Code, nonEmpty(first.Name, "name unknown"), first.Status, first.Score))
	if first.Pivot != nil {
		b.WriteString(fmt.Sprintf(", pivot A$%.2f", *first.Pivot))
	}
	b.WriteString(".")
	if usesFundamentals(st) && out.UniverseCount > 0 {
		b.WriteString(fmt.Sprintf(" Fundamentals cover %d of %d stocks evaluated; without them the growth rules read unknown.",
			out.FundamentalsCoverageCount, out.UniverseCount))
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
