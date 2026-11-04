package shorts

import (
	"fmt"
	"testing"
	"time"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ownershipTestNow is the build time of every universe in these tests.
var ownershipTestNow = time.Date(2026, 11, 2, 9, 0, 0, 0, time.UTC)

// ownershipFixture: PLS is crowded both ways (a hedge fund and an active
// manager long, 12% short); BHP is held by index funds and lent by a bank;
// MIN has only a corporate holder, which "crowded" does not count.
func ownershipFixture() *ownershipData {
	return &ownershipData{
		institutions: []shortsstore.OwnershipInstitutionRow{
			{Slug: "regal-partners", Name: "Regal Partners", Kind: "hedge_fund"},
			{Slug: "perpetual", Name: "Perpetual", Kind: "active_manager"},
			{Slug: "citigroup", Name: "Citigroup", Kind: "bank_broker"},
			{Slug: "vanguard", Name: "Vanguard", Kind: "index_manager"},
			{Slug: "hostplus", Name: "Hostplus", Kind: "super_fund", AUM: new(1.2e11), AUMAsAt: "2025-06-30"},
		},
		holdings: []shortsstore.SubstantialHoldingRow{
			{StockCode: "PLS", HolderKey: "regal-partners", InstitutionSlug: "regal-partners", Kind: "hedge_fund", PresentPct: 6, AnnouncedOn: "2026-10-02"},
			{StockCode: "PLS", HolderKey: "perpetual", InstitutionSlug: "perpetual", Kind: "active_manager", PresentPct: 5.5, AnnouncedOn: "2026-09-18"},
			{StockCode: "BHP", HolderKey: "citigroup", InstitutionSlug: "citigroup", Kind: "bank_broker", PresentPct: 6.3, AnnouncedOn: "2026-10-07"},
			{StockCode: "BHP", HolderKey: "vanguard", InstitutionSlug: "vanguard", Kind: "index_manager", PresentPct: 5.1, AnnouncedOn: "2026-09-29"},
			{StockCode: "MIN", HolderKey: "name:chris ellison", Kind: "unclassified", PresentPct: 12},
			{StockCode: "WC8", HolderKey: "asx:MIN", Kind: "corporate", PresentPct: 14.6},
		},
		stats: &shortsstore.NoticeStats{Parsed: 9, Withheld: 8, LatestAnnounced: "2026-10-16",
			PerHolder: map[string]shortsstore.HolderNoticeStats{"citigroup": {Notices: 3, LatestNotice: "2026-10-07"}}},
		fundHoldings: []shortsstore.FundHoldingRow{
			{InstitutionSlug: "vanguard", FundName: "VAS", SourceKind: "etf", AsAt: "2026-09-30", StockCode: "BHP", Units: new(100e6), Value: new(6e9)},
			{InstitutionSlug: "blackrock", FundName: "IOZ", SourceKind: "etf", AsAt: "2026-10-15", StockCode: "BHP", Units: new(18e6), Value: new(1e9)},
			{InstitutionSlug: "hostplus", FundName: "Balanced", SourceKind: "super_phd", AsAt: "2026-06-30", StockCode: "BHP", Units: new(26e6), Value: new(1.5e9)},
			{InstitutionSlug: "hostplus", FundName: "Balanced", SourceKind: "super_phd", AsAt: "2026-06-30", StockCode: "PLS", Value: new(2e8)},
		},
		funds: []shortsstore.OwnershipFundRow{
			{FundKey: "abn:1", Name: "Hostplus", FundType: "super_fund", InstitutionSlug: "hostplus", Size: new(1.2e11)},
			{FundKey: "asx:VAS", Name: "VAS", FundType: "etf", InstitutionSlug: "vanguard", Size: new(2.1e10)},
			{FundKey: "asx:AFI", Name: "AFIC", FundType: "lic", Size: new(8e9)},
		},
		shorts: map[string]shortsstore.ShortPosition{
			"PLS": {Pct: 12, Issued: 3.2e9, Date: "2026-10-16"},
			"BHP": {Pct: 0.5, Issued: 5.07e9, Date: "2026-10-16"},
			"MIN": {Pct: 6, Issued: 2e8, Date: "2026-10-16"},
			"CBA": {Pct: 1.4, Issued: 1.5e9, Date: "2026-10-16"},
		},
		companies: map[string]shortsstore.OwnershipCompany{
			"PLS": {Name: "PLS Group", Industry: "Materials"},
			"BHP": {Name: "BHP Group", Industry: "Materials", MarketCap: new(3e11)},
			"CBA": {Name: "Commonwealth Bank", Industry: "Banks"},
		},
	}
}

// ownershipFixtureAttempts is nine parsed documents and eight that did not
// parse. Four of those are withholding outcomes (no_text, no_voting_power); the
// other four are documents that were not notices or not yet downloaded.
func ownershipFixtureAttempts() []shortsstore.AttemptOutcomeRow {
	return []shortsstore.AttemptOutcomeRow{
		{StockCode: "PLS", Outcome: "parsed", Count: 6},
		{StockCode: "BHP", Outcome: "parsed", Count: 3},
		{StockCode: "MIN", Outcome: "no_text", Count: 1},
		{StockCode: "BHP", Outcome: "no_text", Count: 2},
		{StockCode: "WC8", Outcome: "no_voting_power", Count: 1},
		{StockCode: "BHP", Outcome: "not_a_notice", Count: 3},
		{StockCode: "PLS", Outcome: "fetch_error", Count: 1},
	}
}

// ownershipFixtureCounts is each stock's parsed notices.
func ownershipFixtureCounts() map[string]int {
	return map[string]int{"BHP": 4, "PLS": 2}
}

func ownershipFixtureUniverse() *ownershipUniverse {
	return newOwnershipUniverse(ownershipFixture(), ownershipFixtureCounts(), ownershipFixtureAttempts(), ownershipTestNow)
}

func TestBuildOwnershipOverview(t *testing.T) {
	u := ownershipFixtureUniverse()
	out := u.overview

	// Crowded counts investors only: BHP's bank (6.3%) is shown beside the
	// register, never summed, so BHP scores its index fund's 5.1%. MIN's and
	// WC8's holders are a person and a company.
	require.Len(t, out.Crowded, 2)
	assert.Equal(t, "PLS", out.Crowded[0].StockCode, "hedge fund + active manager 11.5% beats the index fund's 5.1%")
	codes := []string{out.Crowded[0].StockCode, out.Crowded[1].StockCode}
	assert.ElementsMatch(t, []string{"BHP", "PLS"}, codes)
	assert.InDelta(t, 5.1, institutionalPct(u.views["BHP"]), 1e-9, "the bank is not an investor")

	require.Len(t, out.CrowdedBothWays, 1)
	pls := out.CrowdedBothWays[0]
	assert.Equal(t, "PLS", pls.StockCode)
	assert.InDelta(t, 11.5, pls.DisclosedPct, 1e-9)
	assert.InDelta(t, 12, pls.ShortPct, 1e-9)
	require.Len(t, pls.ByKind, 2)
	assert.Equal(t, "hedge_fund", pls.ByKind[0].Kind)

	require.Len(t, out.Lending, 1)
	assert.Equal(t, "BHP", out.Lending[0].StockCode)

	require.Len(t, out.Passive, 1)
	assert.InDelta(t, 118e6/5.07e9*100, out.Passive[0].IndexPct, 1e-9, "ETF units over shares on issue")

	require.Len(t, out.SuperConsensus, 2)
	assert.Equal(t, "BHP", out.SuperConsensus[0].StockCode)
	assert.EqualValues(t, 1, out.SuperConsensus[0].SuperOptions)

	assert.EqualValues(t, 1, out.SuperFunds)
	assert.EqualValues(t, 1, out.Etfs)
	assert.EqualValues(t, 1, out.Lics)
	assert.InDelta(t, 1.2e11, out.SuperAssetsAud, 1)
	assert.EqualValues(t, 9, out.NoticesParsed)
	assert.EqualValues(t, 8, out.NoticesWithheld)

	// Withheld documents by outcome: every outcome but parsed, largest first,
	// and the total is notices_withheld.
	require.Len(t, out.WithheldByOutcome, 4)
	var withheld int32
	for _, w := range out.WithheldByOutcome {
		withheld += w.Count
	}
	assert.Equal(t, out.NoticesWithheld, withheld, "notices_withheld is the sum of withheld_by_outcome")
	assert.Equal(t, "no_text", out.WithheldByOutcome[0].Outcome, "count descending, then outcome")
	assert.EqualValues(t, 3, out.WithheldByOutcome[0].Count)
	assert.Equal(t, "not_a_notice", out.WithheldByOutcome[1].Outcome)
	assert.EqualValues(t, 17, out.DocumentsAttempted, "parsed included")

	kinds := map[string]int32{}
	for _, k := range out.Kinds {
		kinds[k.Kind] = k.Positions
	}
	assert.EqualValues(t, 1, kinds["hedge_fund"])
	assert.EqualValues(t, 1, kinds["corporate"])
	assert.EqualValues(t, 0, kinds["super_fund"], "a registry kind with no positions is still on the map")
	require.NotEmpty(t, out.TopHolders)
	for _, h := range out.TopHolders {
		assert.Positive(t, h.SubstantialPositions)
	}

	require.Len(t, out.Sources, 3)
	notices := out.Sources[0]
	assert.Equal(t, "substantial_notices", notices.Source)
	assert.EqualValues(t, 0, notices.Funds)
	assert.Empty(t, notices.AsAtFrom, "notices carry one date, not a range")
	etf := out.Sources[1]
	assert.Equal(t, "etf", etf.Source)
	assert.EqualValues(t, 2, etf.Funds, "VAS and IOZ")
	assert.Equal(t, "2026-09-30", etf.AsAtFrom, "the oldest file")
	assert.Equal(t, "2026-10-15", etf.AsAt, "the newest file")
	superSource := out.Sources[2]
	assert.EqualValues(t, 1, superSource.Funds, "one option: Hostplus's Balanced")
	assert.Equal(t, "2026-06-30", superSource.AsAtFrom)
	assert.Equal(t, "2026-06-30", superSource.AsAt)
}

// Every stock view carries the dates behind its figures: ASIC's report for the
// short, the file range behind the index figure, and the newest notice release.
func TestStockViewsCarryTheirDates(t *testing.T) {
	u := ownershipFixtureUniverse()
	bhp := u.views["BHP"]
	assert.Equal(t, "2026-10-16", bhp.ShortAsOf)
	assert.Equal(t, "2026-10-07", bhp.LatestNoticeDate, "the newest release among BHP's current holders")
	assert.Equal(t, "2026-09-30", bhp.IndexAsAtFrom)
	assert.Equal(t, "2026-10-15", bhp.IndexAsAtTo)
	assert.EqualValues(t, 2, bhp.IndexFiles)

	// PLS has no index figure, so it has no index dates either.
	pls := u.views["PLS"]
	assert.Empty(t, pls.IndexAsAtFrom)
	assert.Empty(t, pls.IndexAsAtTo)
	assert.Zero(t, pls.IndexFiles)
}

func TestBuildInstitutionList(t *testing.T) {
	d := ownershipFixture()
	all := buildInstitutionList(d, "", "", 200, 0, ownershipTestNow)
	assert.EqualValues(t, 5, all.Total)
	// Positions first, then assets: Hostplus has none but the largest AUM.
	assert.Equal(t, "hostplus", all.Institutions[len(all.Institutions)-1].Slug)
	hedge := buildInstitutionList(d, "hedge_fund", "", 200, 0, ownershipTestNow)
	require.Len(t, hedge.Institutions, 1)
	assert.Equal(t, "regal-partners", hedge.Institutions[0].Slug)
	found := buildInstitutionList(d, "", "vang", 200, 0, ownershipTestNow)
	require.Len(t, found.Institutions, 1)
	paged := buildInstitutionList(d, "", "", 2, 4, ownershipTestNow)
	assert.Len(t, paged.Institutions, 1)
	assert.EqualValues(t, 5, paged.Total)
}

// positions_gained counts a holder's current 603s released in the default window,
// the 91 days ending at the newest notice. A 604 is a move, not a gain; a 603 from
// before the window and a holding with no stated form count nothing; the window's
// first day counts and the day before it does not.
func TestPositionsGainedCountsBecameSubstantialInTheWindow(t *testing.T) {
	d := &ownershipData{
		institutions: []shortsstore.OwnershipInstitutionRow{
			{Slug: "alpha", Name: "Alpha Capital", Kind: "hedge_fund"},
			{Slug: "beta", Name: "Beta Super", Kind: "super_fund"},
		},
		holdings: []shortsstore.SubstantialHoldingRow{
			{StockCode: "AAA", HolderKey: "alpha", InstitutionSlug: "alpha", Kind: "hedge_fund", Form: "603", AnnouncedOn: "2026-10-02"},
			{StockCode: "BBB", HolderKey: "alpha", InstitutionSlug: "alpha", Kind: "hedge_fund", Form: "604", AnnouncedOn: "2026-10-05"},
			{StockCode: "CCC", HolderKey: "alpha", InstitutionSlug: "alpha", Kind: "hedge_fund", Form: "603", AnnouncedOn: "2026-05-01"},
			{StockCode: "FFF", HolderKey: "alpha", InstitutionSlug: "alpha", Kind: "hedge_fund", Form: "603", AnnouncedOn: "2026-07-18"},
			{StockCode: "GGG", HolderKey: "alpha", InstitutionSlug: "alpha", Kind: "hedge_fund", Form: "603", AnnouncedOn: "2026-07-17"},
			{StockCode: "DDD", HolderKey: "beta", InstitutionSlug: "beta", Kind: "super_fund", Form: "", AnnouncedOn: "2026-10-09"},
			{StockCode: "EEE", HolderKey: "beta", InstitutionSlug: "beta", Kind: "super_fund", Form: "603", AnnouncedOn: "2026-10-12"},
		},
		stats: &shortsstore.NoticeStats{LatestAnnounced: "2026-10-16", PerHolder: map[string]shortsstore.HolderNoticeStats{}},
	}
	out := buildInstitutionList(d, "", "", 200, 0, ownershipTestNow)
	byslug := map[string]*shortsv1alpha1.OwnershipInstitution{}
	for _, i := range out.Institutions {
		byslug[i.Slug] = i
	}
	require.Len(t, byslug, 2)
	// Alpha: AAA and FFF are 603s in the window; BBB is a 604, CCC is too old, GGG
	// is the day before the window.
	assert.EqualValues(t, 5, byslug["alpha"].SubstantialPositions)
	assert.EqualValues(t, 2, byslug["alpha"].PositionsGained)
	// Beta: EEE is the one 603; DDD has no form.
	assert.EqualValues(t, 2, byslug["beta"].SubstantialPositions)
	assert.EqualValues(t, 1, byslug["beta"].PositionsGained)
	for _, i := range out.Institutions {
		assert.LessOrEqual(t, i.PositionsGained, i.SubstantialPositions, "gained never exceeds the positions held")
	}
}

func TestBuildInstitutionAndStock(t *testing.T) {
	u := ownershipFixtureUniverse()
	inst := buildInstitution(u, "citigroup", nil)
	require.NotNil(t, inst.Institution)
	assert.EqualValues(t, 3, inst.Institution.Notices)
	assert.Nil(t, buildInstitution(u, "nobody", nil).Institution)
	hostplus := buildInstitution(u, "hostplus", nil)
	assert.EqualValues(t, 2, hostplus.FundHoldingsTotal, "both Balanced rows: BHP and PLS")

	stock := buildStockOwnership(u, "BHP", nil)
	require.NotNil(t, stock.Summary)
	assert.EqualValues(t, 2, stock.Summary.Holders)
	assert.True(t, stock.HasSharesOnIssue)
	require.Len(t, stock.Holders, 2)
	assert.Equal(t, "citigroup", stock.Holders[0].HolderKey, "largest voting power first")
	for _, fh := range stock.FundHoldings {
		if fh.FundName == "VAS" {
			assert.True(t, fh.HasPctOfIssued)
			assert.InDelta(t, 100e6/5.07e9*100, fh.PctOfIssued, 1e-9)
		}
	}
	assert.EqualValues(t, 4, stock.HistoryTotal, "the stock's parsed notices on record")
	assert.EqualValues(t, 2, stock.WithheldListed, "no_text only: not_a_notice is not a withheld notice")
	assert.Equal(t, "2026-10-16", stock.AsOf)

	// The summary is a copy: a caller cannot change the universe's view.
	stock.Summary.Holders = 99
	assert.EqualValues(t, 2, u.views["BHP"].Holders)

	// A stock with no holders still names itself, its short interest and the
	// short's date.
	cba := buildStockOwnership(u, "CBA", nil)
	require.NotNil(t, cba.Summary)
	assert.Equal(t, "CBA", cba.Summary.StockCode)
	assert.True(t, cba.Summary.HasShortPct)
	assert.Equal(t, "2026-10-16", cba.Summary.ShortAsOf)
	assert.Empty(t, cba.Holders)

	none := buildStockOwnership(u, "MIN", nil)
	require.NotNil(t, none.Summary)
	assert.Equal(t, "MIN", none.Summary.StockCode)
	assert.EqualValues(t, 1, none.WithheldListed)
	assert.EqualValues(t, 0, none.HistoryTotal)
}

// A large institution's file holdings are capped at the largest 100, and the
// total says how many rows the files hold. The files list the largest value
// first, as the store orders them, and the codes run the other way, so the test
// can tell the file's order from the code's.
func TestInstitutionFundHoldingsAreCapped(t *testing.T) {
	const rows = 105
	d := &ownershipData{
		institutions: []shortsstore.OwnershipInstitutionRow{{Slug: "bigfund", Name: "Big Fund", Kind: "super_fund"}},
		stats:        &shortsstore.NoticeStats{PerHolder: map[string]shortsstore.HolderNoticeStats{}},
	}
	for i := range rows {
		d.fundHoldings = append(d.fundHoldings, shortsstore.FundHoldingRow{
			InstitutionSlug: "bigfund", FundName: "Option", SourceKind: "super_phd", AsAt: "2026-06-30",
			StockCode: fmt.Sprintf("S%03d", rows-1-i), Value: new(float64(rows - i)),
		})
	}
	u := newOwnershipUniverse(d, nil, nil, ownershipTestNow)
	out := buildInstitution(u, "bigfund", nil)
	assert.EqualValues(t, rows, out.FundHoldingsTotal)
	require.Len(t, out.FundHoldings, institutionFundHoldings)
	assert.Equal(t, "S104", out.FundHoldings[0].StockCode, "the largest by value comes first, whatever its code")
	assert.InDelta(t, rows, out.FundHoldings[0].ValueAud, 1e-9)
	assert.InDelta(t, rows-institutionFundHoldings+1, out.FundHoldings[institutionFundHoldings-1].ValueAud, 1e-9,
		"the hundredth largest is the last one served")
}

func TestOwnershipUniverseCarriesItsCountsAndAttempts(t *testing.T) {
	u := ownershipFixtureUniverse()
	assert.EqualValues(t, 4, u.noticeCountByStock["BHP"])
	assert.Equal(t, 3, u.attemptsByStock["BHP"]["not_a_notice"])
	assert.Equal(t, 3, u.byOutcome["no_text"])
	assert.Equal(t, 17, u.documentsAttempted)
}

func TestCountedHoldingsCountEachInterestOnce(t *testing.T) {
	groups := map[string]string{"first-sentier": "mufg", "morgan-stanley": "mufg"}
	holdings := []shortsstore.SubstantialHoldingRow{
		// MUFG files for First Sentier's shares: the same 5.16% twice.
		{StockCode: "HLS", HolderKey: "mufg", InstitutionSlug: "mufg", Kind: "bank_broker", PresentPct: 5.16, EventDate: "2026-10-01"},
		{StockCode: "HLS", HolderKey: "first-sentier", InstitutionSlug: "first-sentier", Kind: "active_manager", PresentPct: 5.16, EventDate: "2026-10-01"},
		// Two unrelated holders lodging one interest (a buyer and the seller's associate).
		{StockCode: "HLS", HolderKey: "kkr", InstitutionSlug: "kkr", Kind: "private_equity", PresentPct: 6.15, EventDate: "2025-12-01"},
		{StockCode: "HLS", HolderKey: "commonwealth-bank", InstitutionSlug: "commonwealth-bank", Kind: "bank_broker", PresentPct: 6.15, EventDate: "2025-12-01"},
		{StockCode: "HLS", HolderKey: "spheria", InstitutionSlug: "spheria", Kind: "active_manager", PresentPct: 15.59, EventDate: "2026-09-18"},
		// MUFG's 6.12% includes Morgan Stanley's 5.31%: the group counts its largest.
		{StockCode: "PLS", HolderKey: "mufg", InstitutionSlug: "mufg", Kind: "bank_broker", PresentPct: 6.12, EventDate: "2026-10-14"},
		{StockCode: "PLS", HolderKey: "morgan-stanley", InstitutionSlug: "morgan-stanley", Kind: "bank_broker", PresentPct: 5.31, EventDate: "2026-10-14"},
	}
	got := map[string][]string{}
	for _, h := range countedHoldings(holdings, groups) {
		got[h.StockCode] = append(got[h.StockCode], h.HolderKey)
	}
	assert.Equal(t, []string{"first-sentier", "kkr", "spheria"}, got["HLS"])
	assert.Equal(t, []string{"mufg"}, got["PLS"])

	d := &ownershipData{
		institutions: []shortsstore.OwnershipInstitutionRow{{Slug: "first-sentier", Group: "mufg"}, {Slug: "morgan-stanley", Group: "mufg"}},
		holdings:     holdings,
	}
	views := d.stockViews()
	assert.Equal(t, int32(5), views["HLS"].Holders, "every holder is still counted as a holder")
	assert.InDelta(t, 5.16+6.15+15.59, views["HLS"].DisclosedPct, 1e-9)
	assert.InDelta(t, 6.12, views["PLS"].DisclosedPct, 1e-9)
}
