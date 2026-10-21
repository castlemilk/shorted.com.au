package mcp

import (
	"context"
	"errors"
	"strings"
	"testing"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
)

// ownershipStock is a small register in production's shapes: a 604 with a
// previous figure, a 603 without one, a super option named bare ("Growth"),
// an ETF whose name already carries its manager, and a holding whose file
// states a 0.00% weight beside a real value.
func ownershipStock() *shortsv1alpha1.GetStockOwnershipResponse {
	return &shortsv1alpha1.GetStockOwnershipResponse{
		Summary: &shortsv1alpha1.OwnershipStock{
			StockCode: "DRO", CompanyName: "Droneshield", Holders: 2, DisclosedPct: 12.8154,
			ByKind: []*shortsv1alpha1.KindShare{
				{Kind: "index_manager", Pct: 7.74, Holders: 1},
				{Kind: "bank_broker", Pct: 5.0754, Holders: 1},
			},
			ShortPct: 16.4008, HasShortPct: true, IndexPct: 3.2164, HasIndexPct: true,
			SuperOptions: 2, SuperValueAud: 6_375_341.4, HasSuperValue: true,
		},
		Holders: []*shortsv1alpha1.SubstantialHolding{
			{HolderName: "State Street Corporation", InstitutionSlug: "state-street", Kind: "index_manager", Form: "604",
				VotingPowerPct: 7.74, PreviousPct: 6.41, HasPrevious: true, EventDate: "2026-09-02", AnnouncedOn: "2026-09-04"},
			{HolderName: "Citigroup Global Markets Australia Pty Limited", InstitutionSlug: "citigroup", Kind: "bank_broker",
				Form: "603", VotingPowerPct: 5.0754, AnnouncedOn: "2026-10-12"},
		},
		FundHoldings: []*shortsv1alpha1.FundHolding{
			{InstitutionSlug: "rest", InstitutionName: "Rest", FundName: "Growth", SourceKind: "super_phd",
				ValueAud: 2_968_132, HasValue: true, HasWeight: true, PctOfIssued: 0.1325, HasPctOfIssued: true},
			{InstitutionSlug: "vanguard", InstitutionName: "Vanguard", FundName: "Vanguard Australian Shares Index Fund (VAS)",
				FundCode: "VAS", SourceKind: "etf", ValueAud: 30_919_541, HasValue: true, WeightPct: 0.05694, HasWeight: true,
				PctOfIssued: 1.9651, HasPctOfIssued: true},
			{InstitutionSlug: "hesta", InstitutionName: "HESTA", FundName: "Balanced Growth", SourceKind: "super_phd",
				ValueAud: 3_407_209.4, HasValue: true, WeightPct: 0.0043, HasWeight: true},
		},
	}
}

func TestGetStockOwnershipNamesEveryFundWithItsInstitution(t *testing.T) {
	src := &fakeDataSource{stockOwnership: ownershipStock()}
	res, out, err := getStockOwnershipHandler(src)(context.Background(), nil, GetStockOwnershipInput{Code: "dro"})
	if err != nil {
		t.Fatal(err)
	}
	if src.gotStockOwnership.GetStockCode() != "DRO" {
		t.Errorf("requested %q, want the normalised DRO", src.gotStockOwnership.GetStockCode())
	}
	var names []string
	for _, f := range out.Funds {
		names = append(names, f.Fund)
	}
	// Largest first, a bare option named with its fund, a name that already
	// carries its manager left alone.
	want := []string{"Vanguard Australian Shares Index Fund (VAS)", "HESTA: Balanced Growth", "Rest: Growth"}
	if strings.Join(names, "|") != strings.Join(want, "|") {
		t.Errorf("funds = %q, want %q", names, want)
	}
	if out.Funds[0].Source != "etf" || out.Funds[1].Source != "super" {
		t.Errorf("sources = %q, %q, want etf and super", out.Funds[0].Source, out.Funds[1].Source)
	}
	// Four places, so a small cap's weight is not printed as 0.
	if w := out.Funds[1].WeightPct; w == nil || *w != 0.0043 {
		t.Errorf("HESTA weight = %v, want 0.0043", w)
	}
	if !strings.Contains(textOf(t, res), "2 substantial holders disclose 12.82% in sum (not a share of the company)") {
		t.Errorf("summary = %q", textOf(t, res))
	}
}

// A missing figure is absent, never zero: a 603 has no previous voting power,
// a fund without a stated share of issue has none, and a 0.00% weight beside
// A$2.97M is the file's rounding, not a weight of nothing.
func TestGetStockOwnershipLeavesUnknownFiguresOut(t *testing.T) {
	_, out, err := getStockOwnershipHandler(&fakeDataSource{stockOwnership: ownershipStock()})(
		context.Background(), nil, GetStockOwnershipInput{Code: "DRO"})
	if err != nil {
		t.Fatal(err)
	}
	if out.Substantial[1].PreviousPct != nil {
		t.Errorf("a 603's previous voting power = %v, want absent", *out.Substantial[1].PreviousPct)
	}
	if p := out.Substantial[0].PreviousPct; p == nil || *p != 6.41 {
		t.Errorf("a 604's previous voting power = %v, want 6.41", p)
	}
	rest := out.Funds[2]
	if rest.WeightPct != nil {
		t.Errorf("Rest's stated 0.00%% weight = %v, want absent", *rest.WeightPct)
	}
	if out.Funds[1].PctOfShares != nil {
		t.Errorf("HESTA's unstated share of issue = %v, want absent", *out.Funds[1].PctOfShares)
	}
	if out.MarketCapAUD != nil {
		t.Errorf("market cap = %v with no has_market_cap, want absent", *out.MarketCapAUD)
	}
}

func TestGetStockOwnershipCapsRowsAndSaysHowManyWereLeftOut(t *testing.T) {
	resp := ownershipStock()
	for len(resp.Holders) < maxOwnershipHolders+3 {
		resp.Holders = append(resp.Holders, resp.Holders[1])
	}
	for len(resp.FundHoldings) < maxOwnershipFunds+5 {
		resp.FundHoldings = append(resp.FundHoldings, resp.FundHoldings[0])
	}
	_, out, err := getStockOwnershipHandler(&fakeDataSource{stockOwnership: resp})(
		context.Background(), nil, GetStockOwnershipInput{Code: "DRO"})
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Substantial) != maxOwnershipHolders || len(out.Funds) != maxOwnershipFunds {
		t.Fatalf("rows = %d holders, %d funds, want %d and %d", len(out.Substantial), len(out.Funds),
			maxOwnershipHolders, maxOwnershipFunds)
	}
	for _, want := range []string{"3 substantial holders were not returned", "5 smaller fund holdings were not returned"} {
		if !strings.Contains(out.Note, want) {
			t.Errorf("note %q lacks %q", out.Note, want)
		}
	}
}

// No holder is "nobody holds 5%", which is a claim; an empty body is the API
// with ownership switched off, which is no claim at all.
func TestGetStockOwnershipDistinguishesUnavailableFromNoHolders(t *testing.T) {
	ctx := context.Background()
	off := &fakeDataSource{stockOwnership: &shortsv1alpha1.GetStockOwnershipResponse{}}
	if _, _, err := getStockOwnershipHandler(off)(ctx, nil, GetStockOwnershipInput{Code: "BHP"}); err == nil ||
		!strings.Contains(err.Error(), "unavailable") {
		t.Fatalf("empty body = %v, want an explicit unavailability error", err)
	}

	none := &fakeDataSource{stockOwnership: &shortsv1alpha1.GetStockOwnershipResponse{
		Summary: &shortsv1alpha1.OwnershipStock{StockCode: "CBA", CompanyName: "Commonwealth Bank"}}}
	res, out, err := getStockOwnershipHandler(none)(ctx, nil, GetStockOwnershipInput{Code: "CBA"})
	if err != nil {
		t.Fatal(err)
	}
	if out.DisclosedPct != nil {
		t.Errorf("disclosed sum over no holders = %v, want absent", *out.DisclosedPct)
	}
	if !strings.Contains(textOf(t, res), "no current substantial holder on record") {
		t.Errorf("summary = %q", textOf(t, res))
	}
}

func TestGetStockOwnershipValidatesTheTicker(t *testing.T) {
	src := &fakeDataSource{stockOwnership: ownershipStock()}
	if _, _, err := getStockOwnershipHandler(src)(context.Background(), nil, GetStockOwnershipInput{Code: "not a code"}); err == nil {
		t.Fatal("accepted an invalid ticker")
	}
	if src.gotStockOwnership != nil {
		t.Error("an invalid ticker reached the API")
	}
}

func ownershipInstitution(slug, name string) *shortsv1alpha1.GetInstitutionResponse {
	return &shortsv1alpha1.GetInstitutionResponse{
		Institution: &shortsv1alpha1.OwnershipInstitution{Slug: slug, Name: name, Kind: "super_fund",
			AumAud: 412_301_040_000, HasAum: true, SubstantialPositions: 1, Notices: 3, Funds: 1},
		Positions: []*shortsv1alpha1.SubstantialHolding{
			{StockCode: "SYR", CompanyName: "Syrah Resources", VotingPowerPct: 49.5, PreviousPct: 45.65, HasPrevious: true,
				Form: "604", AnnouncedOn: "2026-04-28"},
		},
	}
}

func ownershipRegistry() *shortsv1alpha1.ListInstitutionsResponse {
	return &shortsv1alpha1.ListInstitutionsResponse{Institutions: []*shortsv1alpha1.OwnershipInstitution{
		{Slug: "australiansuper", Name: "AustralianSuper"},
		{Slug: "aware-super", Name: "Aware Super"},
		{Slug: "unisuper", Name: "UniSuper"},
		{Slug: "state-street", Name: "State Street"},
	}, Total: 4}
}

func TestGetInstitutionHoldingsReadsASlugWithoutSearching(t *testing.T) {
	src := &fakeDataSource{institution: ownershipInstitution("state-street", "State Street"), institutions: ownershipRegistry()}
	_, out, err := getInstitutionHoldingsHandler(src)(context.Background(), nil, GetInstitutionHoldingsInput{Institution: "state-street"})
	if err != nil {
		t.Fatal(err)
	}
	if out.Slug != "state-street" || src.gotListInstitution != nil {
		t.Errorf("slug %q, searched = %v; a slug must be read directly", out.Slug, src.gotListInstitution != nil)
	}
}

// "Australian Super" and "australian super" are the same fund to a reader;
// the slug is australiansuper, so the slug read misses and the name finds it.
func TestGetInstitutionHoldingsResolvesAName(t *testing.T) {
	for _, asked := range []string{"AustralianSuper", "Australian Super", "australian super"} {
		src := &fakeDataSource{institution: ownershipInstitution("australiansuper", "AustralianSuper"),
			institutions: ownershipRegistry()}
		_, out, err := getInstitutionHoldingsHandler(src)(context.Background(), nil, GetInstitutionHoldingsInput{Institution: asked})
		if err != nil {
			t.Fatalf("%q: %v", asked, err)
		}
		if out.Slug != "australiansuper" {
			t.Errorf("%q resolved to %q", asked, out.Slug)
		}
	}
}

// Picking one of several would answer about a fund the caller did not name.
func TestGetInstitutionHoldingsListsAnAmbiguousNameRatherThanPicking(t *testing.T) {
	src := &fakeDataSource{institutions: ownershipRegistry()}
	_, _, err := getInstitutionHoldingsHandler(src)(context.Background(), nil, GetInstitutionHoldingsInput{Institution: "super"})
	if err == nil {
		t.Fatal("an ambiguous name resolved to one institution")
	}
	for _, slug := range []string{"australiansuper", "aware-super", "unisuper"} {
		if !strings.Contains(err.Error(), slug) {
			t.Errorf("error %q does not list %s", err, slug)
		}
	}
	if strings.Contains(err.Error(), "state-street") {
		t.Errorf("error %q lists an institution that does not match", err)
	}
}

func TestGetInstitutionHoldingsFailsOnAnUnknownNameOrABackendError(t *testing.T) {
	ctx := context.Background()
	src := &fakeDataSource{institutions: ownershipRegistry()}
	if _, _, err := getInstitutionHoldingsHandler(src)(ctx, nil, GetInstitutionHoldingsInput{Institution: "Nope Capital"}); err == nil ||
		!strings.Contains(err.Error(), "no institution") {
		t.Errorf("unknown name = %v, want a no-match error", err)
	}
	if _, _, err := getInstitutionHoldingsHandler(src)(ctx, nil, GetInstitutionHoldingsInput{Institution: "  "}); err == nil {
		t.Error("accepted an empty institution")
	}
	// Ownership switched off answers NotFound and an empty registry: that is
	// unavailability, not a misspelt name.
	off := &fakeDataSource{institutions: &shortsv1alpha1.ListInstitutionsResponse{}}
	if _, _, err := getInstitutionHoldingsHandler(off)(ctx, nil, GetInstitutionHoldingsInput{Institution: "vanguard"}); err == nil ||
		!strings.Contains(err.Error(), "unavailable") {
		t.Errorf("empty registry = %v, want an unavailability error", err)
	}
	broken := &fakeDataSource{err: connect.NewError(connect.CodeInternal, errors.New("boom"))}
	if _, _, err := getInstitutionHoldingsHandler(broken)(ctx, nil, GetInstitutionHoldingsInput{Institution: "vanguard"}); err == nil ||
		!strings.Contains(err.Error(), "could not read") {
		t.Errorf("backend failure = %v, want it surfaced, not turned into a search", err)
	}
	if _, _, err := getStockOwnershipHandler(broken)(ctx, nil, GetStockOwnershipInput{Code: "BHP"}); err == nil {
		t.Error("get_stock_ownership swallowed a backend failure")
	}
}

// AustralianSuper has no holdings file loaded; an empty list there must not
// read as a fund that holds nothing.
func TestGetInstitutionHoldingsSaysAMissingHoldingsFileIsUnknown(t *testing.T) {
	src := &fakeDataSource{institution: ownershipInstitution("australiansuper", "AustralianSuper")}
	res, out, err := getInstitutionHoldingsHandler(src)(context.Background(), nil, GetInstitutionHoldingsInput{Institution: "australiansuper"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.Note, "unknown, not empty") {
		t.Errorf("note %q does not say the holdings are unknown", out.Note)
	}
	if !strings.Contains(textOf(t, res), "1 current substantial stake from 3 notices read; 1 product tracked") {
		t.Errorf("summary = %q", textOf(t, res))
	}
	if out.AumAUD == nil || *out.AumAUD != 412_301_040_000 {
		t.Errorf("aum = %v", out.AumAUD)
	}
}

func TestOwnershipToolsAreRegisteredAgainstTheirRPCs(t *testing.T) {
	want := map[string]string{
		"get_stock_ownership":      "shorts.v1alpha1.OwnershipService.GetStockOwnership",
		"get_institution_holdings": "shorts.v1alpha1.OwnershipService.GetInstitution",
	}
	got := map[string]string{}
	for _, tool := range Registry() {
		if tool.Domain == "ownership" {
			got[tool.Name] = tool.RPC
		}
	}
	if len(got) != len(want) {
		t.Fatalf("registered ownership tools = %v, want %v", got, want)
	}
	for name, rpc := range want {
		if got[name] != rpc {
			t.Errorf("%s declares RPC %q, want %q", name, got[name], rpc)
		}
	}
}

// The two misreadings this data invites, stated where a model reads before it
// calls: a sum is not a share of the company, and a super disclosure is one
// option. And the withheld rule, so an absent holder is not read as absence.
func TestOwnershipToolDescriptionsStateTheCaveats(t *testing.T) {
	for _, tool := range Registry() {
		if tool.Domain != "ownership" {
			continue
		}
		for _, want := range []string{"ONE option, not the whole fund", "withheld, never estimated"} {
			if !strings.Contains(tool.Description, want) {
				t.Errorf("%s description lacks %q", tool.Name, want)
			}
		}
	}
	if !strings.Contains(getStockOwnershipDescription, "NOT a share") {
		t.Error("get_stock_ownership does not say a sum is not a share of the company")
	}
}
