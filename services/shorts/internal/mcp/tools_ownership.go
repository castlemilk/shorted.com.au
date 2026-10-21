package mcp

import (
	"context"
	"errors"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// Ownership tools: who holds an ASX stock, and what one institution holds.
//
// Three sources sit behind these, and none is blended into another:
//
//  1. ASX substantial holding notices (Forms 603/604/605). A figure is the
//     notice's own voting power as at the notice. Notices overlap (a bank files
//     for its fund manager, MUFG for First Sentier), so a SUM is what the
//     notices disclose, never a share of the company. The API already counts a
//     registry group, and identical (voting power, date) pairs, once.
//  2. Index ETF holdings files: shares held by the fund.
//  3. Super fund portfolio holdings disclosures, semi-annual: ONE investment
//     option each, not the whole fund.
//
// A notice the parser could not read is withheld, never estimated, so an
// absent holder is not evidence of absence. Kinds are categories of
// institution, not market direction.

const (
	// maxOwnershipHolders bounds the substantial holders of one stock. A stock
	// rarely has more than eight; the cap is for the pathological register.
	maxOwnershipHolders = 15
	// maxOwnershipFunds bounds the fund rows of one stock: the largest by value.
	maxOwnershipFunds = 15
	// maxInstitutionStakes bounds one institution's current substantial
	// holdings. State Street has 119.
	maxInstitutionStakes = 25
	// maxInstitutionFundRows bounds one institution's fund holdings rows; the
	// API serves its 100 largest.
	maxInstitutionFundRows = 15
	// maxInstitutionDescription bounds the registry's prose about it.
	maxInstitutionDescription = 400
	// maxInstitutionCandidates bounds the slugs listed when a name is ambiguous.
	maxInstitutionCandidates = 10
)

const ownershipNote = "Sums are what the substantial holding notices disclose, not a share of the company: " +
	"notices overlap, and only a registry group and identical filings are counted once. " +
	"A notice that could not be read is withheld, never estimated. " +
	"A super fund holdings disclosure covers one investment option, not the whole fund. " +
	"A kind is a category of institution, not a market direction."

// --- get_stock_ownership ---

type GetStockOwnershipInput struct {
	Code string `json:"code" jsonschema:"ASX ticker, e.g. BHP. Required."`
}

type OwnershipKindRow struct {
	Kind    string  `json:"kind"`
	Pct     float64 `json:"pct"`
	Holders int     `json:"holders"`
}

type StockHolderRow struct {
	Holder         string   `json:"holder" jsonschema:"As the notice names it."`
	Institution    string   `json:"institution,omitempty" jsonschema:"Slug for get_institution_holdings."`
	Kind           string   `json:"kind"`
	VotingPowerPct float64  `json:"voting_power_pct"`
	PreviousPct    *float64 `json:"previous_pct,omitempty"`
	EventDate      string   `json:"event_date,omitempty"`
	AnnouncedOn    string   `json:"announced_on"`
	NoticeURL      string   `json:"notice_url,omitempty"`
}

type StockFundRow struct {
	Fund        string   `json:"fund" jsonschema:"Institution: fund or option."`
	Institution string   `json:"institution,omitempty"`
	Source      string   `json:"source" jsonschema:"etf or super"`
	ValueAUD    *float64 `json:"value_aud,omitempty"`
	WeightPct   *float64 `json:"weight_pct,omitempty" jsonschema:"Of the fund or option."`
	PctOfShares *float64 `json:"pct_of_shares,omitempty" jsonschema:"Of shares on issue."`
	AsAt        string   `json:"as_at,omitempty"`
}

type GetStockOwnershipOutput struct {
	Code          string             `json:"code"`
	Name          string             `json:"name,omitempty"`
	Holders       int                `json:"holders" jsonschema:"Current 5%+ holders."`
	DisclosedPct  *float64           `json:"disclosed_pct,omitempty" jsonschema:"Their voting power summed; see note."`
	ByKind        []OwnershipKindRow `json:"by_kind"`
	ShortPct      *float64           `json:"short_pct,omitempty"`
	IndexFundPct  *float64           `json:"index_fund_pct,omitempty" jsonschema:"Held by the index funds tracked, % of shares on issue. Vanguard's files are the whole fund, its unlisted classes included."`
	SuperOptions  int                `json:"super_options"`
	SuperValueAUD *float64           `json:"super_value_aud,omitempty"`
	MarketCapAUD  *float64           `json:"market_cap_aud,omitempty"`
	Substantial   []StockHolderRow   `json:"substantial_holders"`
	Funds         []StockFundRow     `json:"funds"`
	Note          string             `json:"note"`
}

const getStockOwnershipDescription = "Who owns one ASX company: current substantial (5%+) holders from ASX notices " +
	"(voting power, change, dates, notice link), their sum by kind of institution, and the index ETFs and super fund " +
	"options holding it (value, weight in the fund, % of shares on issue). A sum is what the notices disclose, NOT a share " +
	"of the company: notices overlap. A super fund disclosure is ONE option, not the whole fund. Unreadable notices are " +
	"withheld, never estimated: an absent holder is not proof of absence. At most 15 holders and the 15 largest fund holdings."

func getStockOwnershipTool() Tool {
	tool := Tool{
		Name:        "get_stock_ownership",
		Title:       "Who owns one ASX company",
		Description: getStockOwnershipDescription,
		RPC:         "shorts.v1alpha1.OwnershipService.GetStockOwnership",
		Domain:      "ownership",
	}
	tool.register = func(server *sdk.Server, src DataSource) {
		sdk.AddTool(server, tool.spec(), getStockOwnershipHandler(src))
	}
	return tool
}

func getStockOwnershipHandler(src DataSource) sdk.ToolHandlerFor[GetStockOwnershipInput, GetStockOwnershipOutput] {
	return func(ctx context.Context, _ *sdk.CallToolRequest, in GetStockOwnershipInput) (*sdk.CallToolResult, GetStockOwnershipOutput, error) {
		code, err := normaliseCode(in.Code)
		if err != nil {
			return nil, GetStockOwnershipOutput{}, err
		}
		res, err := src.GetStockOwnership(ctx, connect.NewRequest(&shortsv1alpha1.GetStockOwnershipRequest{StockCode: code}))
		if err != nil {
			return nil, GetStockOwnershipOutput{}, fmt.Errorf("could not read the ownership of %s: %w", code, err)
		}
		// The API answers an empty body when ownership is not loaded. Reporting
		// that as "nobody holds 5%" would be a false absence claim.
		if res == nil || res.Msg == nil || res.Msg.GetSummary() == nil {
			return nil, GetStockOwnershipOutput{}, fmt.Errorf(
				"ownership data is currently unavailable, so nothing can be said about who holds %s", code)
		}
		msg, sum := res.Msg, res.Msg.GetSummary()

		out := GetStockOwnershipOutput{
			Code:          nonEmpty(sum.GetStockCode(), code),
			Name:          sum.GetCompanyName(),
			Holders:       int(sum.GetHolders()),
			ByKind:        []OwnershipKindRow{},
			ShortPct:      roundedOptional(sum.GetShortPct(), sum.GetHasShortPct()),
			IndexFundPct:  roundedOptional(sum.GetIndexPct(), sum.GetHasIndexPct()),
			SuperOptions:  int(sum.GetSuperOptions()),
			SuperValueAUD: wholeOptional(sum.GetSuperValueAud(), sum.GetHasSuperValue()),
			MarketCapAUD:  wholeOptional(sum.GetMarketCap(), sum.GetHasMarketCap()),
			Substantial:   []StockHolderRow{},
			Funds:         []StockFundRow{},
			Note:          ownershipNote,
		}
		// A sum over no holders is not 0% held, it is no sum.
		if sum.GetHolders() > 0 {
			out.DisclosedPct = pctOptional(sum.GetDisclosedPct(), true)
		}
		for _, k := range sum.GetByKind() {
			if k == nil {
				continue
			}
			out.ByKind = append(out.ByKind, OwnershipKindRow{Kind: k.GetKind(), Pct: round4(k.GetPct()), Holders: int(k.GetHolders())})
		}
		for _, h := range capItems(msg.GetHolders(), maxOwnershipHolders) {
			if h == nil {
				continue
			}
			out.Substantial = append(out.Substantial, StockHolderRow{
				Holder:         h.GetHolderName(),
				Institution:    h.GetInstitutionSlug(),
				Kind:           h.GetKind(),
				VotingPowerPct: round4(h.GetVotingPowerPct()),
				PreviousPct:    optionalFloat(h.GetPreviousPct(), h.GetHasPrevious()),
				EventDate:      h.GetEventDate(),
				AnnouncedOn:    h.GetAnnouncedOn(),
				NoticeURL:      h.GetAnnouncementUrl(),
			})
		}

		funds := largestFirst(msg.GetFundHoldings())
		for _, f := range capItems(funds, maxOwnershipFunds) {
			out.Funds = append(out.Funds, StockFundRow{
				Fund:        fundLabel(f.GetInstitutionName(), f.GetFundName()),
				Institution: f.GetInstitutionSlug(),
				Source:      fundSource(f.GetSourceKind()),
				ValueAUD:    wholeOptional(f.GetValueAud(), f.GetHasValue()),
				WeightPct:   fundWeight(f),
				PctOfShares: pctOptional(f.GetPctOfIssued(), f.GetHasPctOfIssued()),
				AsAt:        f.GetAsAt(),
			})
		}
		out.Note += omittedNote(len(msg.GetHolders())-len(out.Substantial), "substantial holders") +
			omittedNote(len(funds)-len(out.Funds), "smaller fund holdings")

		return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: stockOwnershipSummary(out)}}}, out, nil
	}
}

func stockOwnershipSummary(out GetStockOwnershipOutput) string {
	var b strings.Builder
	b.WriteString(out.Code + companySuffix(out.Name) + ": ")
	if out.Holders == 0 || out.DisclosedPct == nil {
		b.WriteString("no current substantial holder on record")
	} else {
		verb := "disclose"
		if out.Holders == 1 {
			verb = "discloses"
		}
		fmt.Fprintf(&b, "%s %s %.2f%% in sum (not a share of the company)",
			plural(out.Holders, "substantial holder"), verb, *out.DisclosedPct)
	}
	if out.IndexFundPct != nil {
		fmt.Fprintf(&b, "; the index funds tracked hold %.2f%% of shares on issue", *out.IndexFundPct)
	}
	if out.SuperOptions > 0 {
		fmt.Fprintf(&b, "; %s hold it", plural(out.SuperOptions, "tracked super fund option"))
		if out.SuperValueAUD != nil {
			fmt.Fprintf(&b, " (A$%s combined)", humanAUD(*out.SuperValueAUD))
		}
	}
	b.WriteString(".")
	return b.String()
}

// --- get_institution_holdings ---

type GetInstitutionHoldingsInput struct {
	Institution string `json:"institution" jsonschema:"Slug (from get_stock_ownership) or name, e.g. vanguard or AustralianSuper. Required."`
}

type InstitutionStakeRow struct {
	Code           string   `json:"code"`
	Company        string   `json:"company,omitempty"`
	VotingPowerPct float64  `json:"voting_power_pct"`
	PreviousPct    *float64 `json:"previous_pct,omitempty"`
	EventDate      string   `json:"event_date,omitempty"`
	AnnouncedOn    string   `json:"announced_on"`
	NoticeURL      string   `json:"notice_url,omitempty"`
}

type InstitutionFundRow struct {
	Fund        string   `json:"fund"`
	Code        string   `json:"code" jsonschema:"The stock held."`
	Company     string   `json:"company,omitempty"`
	ValueAUD    *float64 `json:"value_aud,omitempty"`
	WeightPct   *float64 `json:"weight_pct,omitempty" jsonschema:"Of the fund or option."`
	PctOfShares *float64 `json:"pct_of_shares,omitempty" jsonschema:"Of shares on issue."`
	AsAt        string   `json:"as_at,omitempty"`
}

type GetInstitutionHoldingsOutput struct {
	Slug            string                `json:"slug"`
	Name            string                `json:"name"`
	Kind            string                `json:"kind"`
	Description     string                `json:"description,omitempty"`
	AumAUD          *float64              `json:"aum_aud,omitempty" jsonschema:"A super fund's total assets (APRA)."`
	Stakes          int                   `json:"substantial_stakes"`
	Notices         int                   `json:"notices"`
	LatestNotice    string                `json:"latest_notice,omitempty"`
	Products        int                   `json:"products" jsonschema:"Its ETFs, LICs and super funds."`
	ProductsSizeAUD *float64              `json:"products_size_aud,omitempty"`
	CurrentStakes   []InstitutionStakeRow `json:"current_stakes"`
	FundHoldings    []InstitutionFundRow  `json:"fund_holdings" jsonschema:"Largest by value."`
	Note            string                `json:"note"`
}

const getInstitutionHoldingsDescription = "One investor in ASX stocks (super fund, index manager, hedge fund, bank, " +
	"sovereign fund...): its current substantial (5%+) stakes from ASX notices, largest first, and the largest holdings " +
	"in its index ETFs and super fund options. Pass a slug from get_stock_ownership or a name; an ambiguous name returns " +
	"the matching slugs. The registry is curated (about 145 institutions). A super fund disclosure is ONE option, not the " +
	"whole fund; unreadable notices are withheld, never estimated. At most 25 stakes and 15 fund holdings."

func getInstitutionHoldingsTool() Tool {
	tool := Tool{
		Name:        "get_institution_holdings",
		Title:       "What one institution holds on the ASX",
		Description: getInstitutionHoldingsDescription,
		RPC:         "shorts.v1alpha1.OwnershipService.GetInstitution",
		AlsoCalls:   []string{"shorts.v1alpha1.OwnershipService.ListInstitutions"},
		Domain:      "ownership",
	}
	tool.register = func(server *sdk.Server, src DataSource) {
		sdk.AddTool(server, tool.spec(), getInstitutionHoldingsHandler(src))
	}
	return tool
}

func getInstitutionHoldingsHandler(src DataSource) sdk.ToolHandlerFor[GetInstitutionHoldingsInput, GetInstitutionHoldingsOutput] {
	return func(ctx context.Context, _ *sdk.CallToolRequest, in GetInstitutionHoldingsInput) (*sdk.CallToolResult, GetInstitutionHoldingsOutput, error) {
		asked := strings.TrimSpace(in.Institution)
		if asked == "" {
			return nil, GetInstitutionHoldingsOutput{}, errors.New(
				"institution is required: a slug from get_stock_ownership (e.g. vanguard) or a name (e.g. AustralianSuper)")
		}
		msg, err := resolveInstitution(ctx, src, asked)
		if err != nil {
			return nil, GetInstitutionHoldingsOutput{}, err
		}
		inst := msg.GetInstitution()

		out := GetInstitutionHoldingsOutput{
			Slug:            inst.GetSlug(),
			Name:            inst.GetName(),
			Kind:            inst.GetKind(),
			Description:     truncate(inst.GetDescription(), maxInstitutionDescription),
			AumAUD:          wholeOptional(inst.GetAumAud(), inst.GetHasAum()),
			Stakes:          int(inst.GetSubstantialPositions()),
			Notices:         int(inst.GetNotices()),
			LatestNotice:    inst.GetLatestNoticeDate(),
			Products:        int(inst.GetFunds()),
			ProductsSizeAUD: wholeOptional(inst.GetFundsSizeAud(), inst.GetHasFundsSize()),
			CurrentStakes:   []InstitutionStakeRow{},
			FundHoldings:    []InstitutionFundRow{},
			Note:            ownershipNote,
		}
		for _, p := range capItems(msg.GetPositions(), maxInstitutionStakes) {
			if p == nil {
				continue
			}
			out.CurrentStakes = append(out.CurrentStakes, InstitutionStakeRow{
				Code:           p.GetStockCode(),
				Company:        p.GetCompanyName(),
				VotingPowerPct: round4(p.GetVotingPowerPct()),
				PreviousPct:    optionalFloat(p.GetPreviousPct(), p.GetHasPrevious()),
				EventDate:      p.GetEventDate(),
				AnnouncedOn:    p.GetAnnouncedOn(),
				NoticeURL:      p.GetAnnouncementUrl(),
			})
		}

		funds := largestFirst(msg.GetFundHoldings())
		for _, f := range capItems(funds, maxInstitutionFundRows) {
			out.FundHoldings = append(out.FundHoldings, InstitutionFundRow{
				Fund:        fundLabel(f.GetInstitutionName(), f.GetFundName()),
				Code:        f.GetStockCode(),
				Company:     f.GetCompanyName(),
				ValueAUD:    wholeOptional(f.GetValueAud(), f.GetHasValue()),
				WeightPct:   fundWeight(f),
				PctOfShares: pctOptional(f.GetPctOfIssued(), f.GetHasPctOfIssued()),
				AsAt:        f.GetAsAt(),
			})
		}
		// The API serves an institution's 100 largest file holdings, so "more"
		// is all that can be said past that.
		out.Note += omittedNote(len(msg.GetPositions())-len(out.CurrentStakes), "smaller substantial stakes") +
			omittedNote(len(funds)-len(out.FundHoldings), "smaller fund holdings")
		// AustralianSuper, the largest fund, has no holdings disclosure loaded:
		// an empty list there is unknown, never "holds nothing".
		if len(funds) == 0 {
			out.Note += " No holdings file of its is tracked, so its fund holdings are unknown, not empty."
		}

		text := fmt.Sprintf("%s (%s, %s): %s from %s read",
			out.Name, out.Slug, strings.ReplaceAll(out.Kind, "_", " "),
			plural(out.Stakes, "current substantial stake"), plural(out.Notices, "notice"))
		if out.Products > 0 {
			text += "; " + plural(out.Products, "product") + " tracked"
		}
		return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: text + "."}}}, out, nil
	}
}

// resolveInstitution reads an institution by slug, and failing that by name.
// A name that matches several is an error listing them: picking one would
// answer a question about a different institution.
func resolveInstitution(ctx context.Context, src DataSource, asked string) (*shortsv1alpha1.GetInstitutionResponse, error) {
	slug := institutionSlug(asked)
	if slug != "" {
		msg, err := getInstitution(ctx, src, slug)
		if err == nil {
			return msg, nil
		}
		if connect.CodeOf(err) != connect.CodeNotFound {
			return nil, fmt.Errorf("could not read institution %q: %w", asked, err)
		}
	}

	// The whole registry in one page (the handler's ceiling is 200; it holds
	// about 145), matched here so "Australian Super" finds AustralianSuper,
	// which the API's substring query would not.
	list, err := src.ListInstitutions(ctx, connect.NewRequest(&shortsv1alpha1.ListInstitutionsRequest{Limit: 200}))
	if err != nil {
		return nil, fmt.Errorf("could not search the institutions for %q: %w", asked, err)
	}
	// An empty registry is ownership switched off, not a misspelt name.
	if list == nil || list.Msg == nil || len(list.Msg.GetInstitutions()) == 0 {
		return nil, fmt.Errorf("ownership data is currently unavailable, so %q cannot be looked up", asked)
	}
	want := squash(asked)
	var exact, partial []*shortsv1alpha1.OwnershipInstitution
	for _, i := range list.Msg.GetInstitutions() {
		if i == nil || i.GetSlug() == "" {
			continue
		}
		name, s := squash(i.GetName()), squash(i.GetSlug())
		switch {
		case name == want || s == want:
			exact = append(exact, i)
		case want != "" && (strings.Contains(name, want) || strings.Contains(s, want)):
			partial = append(partial, i)
		}
	}
	pick := exact
	if len(pick) == 0 {
		pick = partial
	}
	switch len(pick) {
	case 0:
		return nil, fmt.Errorf("no institution in the ownership registry matches %q; it holds about 145 curated institutions, "+
			"so try a shorter name (e.g. vanguard) or take a slug from get_stock_ownership", asked)
	case 1:
		msg, err := getInstitution(ctx, src, pick[0].GetSlug())
		if err != nil {
			return nil, fmt.Errorf("could not read institution %q: %w", pick[0].GetSlug(), err)
		}
		return msg, nil
	}
	names := make([]string, 0, maxInstitutionCandidates)
	for _, i := range capItems(pick, maxInstitutionCandidates) {
		names = append(names, fmt.Sprintf("%s (%s)", i.GetName(), i.GetSlug()))
	}
	more := ""
	if len(pick) > maxInstitutionCandidates {
		more = fmt.Sprintf(" and %d more", len(pick)-maxInstitutionCandidates)
	}
	return nil, fmt.Errorf("%q matches %d institutions: %s%s. Call again with one slug",
		asked, len(pick), strings.Join(names, ", "), more)
}

func getInstitution(ctx context.Context, src DataSource, slug string) (*shortsv1alpha1.GetInstitutionResponse, error) {
	res, err := src.GetInstitution(ctx, connect.NewRequest(&shortsv1alpha1.GetInstitutionRequest{Slug: slug}))
	if err != nil {
		return nil, err
	}
	if res == nil || res.Msg == nil || res.Msg.GetInstitution() == nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("institution not found"))
	}
	return res.Msg, nil
}

var slugJunk = regexp.MustCompile(`[^a-z0-9]+`)

// institutionSlug is the registry's slug shape for a caller's string: lower
// case, words joined by hyphens. "" when nothing is left.
func institutionSlug(s string) string {
	return strings.Trim(slugJunk.ReplaceAllString(strings.ToLower(s), "-"), "-")
}

// squash compares names without case, spaces or punctuation, so
// "Australian Super" finds AustralianSuper and "state street" finds
// state-street.
func squash(s string) string {
	return slugJunk.ReplaceAllString(strings.ToLower(s), "")
}

// largestFirst orders fund holdings by value, a row without one last.
func largestFirst(in []*shortsv1alpha1.FundHolding) []*shortsv1alpha1.FundHolding {
	out := make([]*shortsv1alpha1.FundHolding, 0, len(in))
	for _, f := range in {
		if f != nil {
			out = append(out, f)
		}
	}
	value := func(f *shortsv1alpha1.FundHolding) float64 {
		if v := f.GetValueAud(); f.GetHasValue() && !math.IsNaN(v) && !math.IsInf(v, 0) {
			return v
		}
		return math.Inf(-1)
	}
	sort.SliceStable(out, func(i, j int) bool { return value(out[i]) > value(out[j]) })
	return out
}

// fundLabel names a fund with its institution, because a super fund's option
// is named bare ("Balanced") and means nothing without whose it is.
func fundLabel(institution, fund string) string {
	switch {
	case fund == "":
		return institution
	case institution == "" || strings.Contains(squash(fund), squash(institution)):
		return fund
	default:
		return institution + ": " + fund
	}
}

// plural counts a noun: "1 notice", "2 notices".
func plural(n int, noun string) string {
	if n == 1 {
		return "1 " + noun
	}
	return fmt.Sprintf("%d %ss", n, noun)
}

// omittedNote says how many rows a cap left out, "" when none.
func omittedNote(n int, what string) string {
	if n <= 0 {
		return ""
	}
	return fmt.Sprintf(" %d %s were not returned.", n, what)
}

func fundSource(kind string) string {
	if kind == "super_phd" {
		return "super"
	}
	return kind
}

// round4 rounds a percentage the API computed to four places; a notice states
// at most four. Non-finite reads as 0 (see finite), only on fields that are
// always present.
func round4(v float64) float64 {
	return finite(math.Round(v*10_000) / 10_000)
}

// pctOptional is optionalFloat rounded to four places: a fund's weight in a
// small cap is often under 0.005%, which two places would print as 0, the
// figure it is not. A value even four places round to zero keeps its digits.
func pctOptional(v float64, has bool) *float64 {
	p := optionalFloat(v, has)
	if p == nil {
		return nil
	}
	if r := math.Round(*p*10_000) / 10_000; r != 0 || *p == 0 {
		return &r
	}
	return p
}

// fundWeight is a holding's weight in its fund. Super disclosures state it to
// two places, so a small holding reads 0.00%: Rest's Growth option held
// A$2.97M of DRO (about 0.0035% of the option) at a stated 0. A stated zero
// beside a positive value is below the file's precision, so it is omitted
// rather than published as no weight.
func fundWeight(f *shortsv1alpha1.FundHolding) *float64 {
	w := pctOptional(f.GetWeightPct(), f.GetHasWeight())
	if w != nil && *w == 0 && f.GetHasValue() && f.GetValueAud() > 0 {
		return nil
	}
	return w
}

// wholeOptional is optionalFloat rounded to whole units, for dollar values and
// share counts whose fractions are noise.
func wholeOptional(v float64, has bool) *float64 {
	if p := optionalFloat(v, has); p != nil {
		r := math.Round(*p)
		return &r
	}
	return nil
}

// humanAUD renders a dollar figure for a sentence: 9.38B, 312M, 45K.
func humanAUD(v float64) string {
	switch a := math.Abs(v); {
	case a >= 1e9:
		return fmt.Sprintf("%.2fB", v/1e9)
	case a >= 1e6:
		return fmt.Sprintf("%.0fM", v/1e6)
	case a >= 1e3:
		return fmt.Sprintf("%.0fK", v/1e3)
	default:
		return fmt.Sprintf("%.0f", v)
	}
}
