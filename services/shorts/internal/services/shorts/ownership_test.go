package shorts

import (
	"testing"

	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

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
			{StockCode: "PLS", HolderKey: "regal-partners", InstitutionSlug: "regal-partners", Kind: "hedge_fund", PresentPct: 6},
			{StockCode: "PLS", HolderKey: "perpetual", InstitutionSlug: "perpetual", Kind: "active_manager", PresentPct: 5.5},
			{StockCode: "BHP", HolderKey: "citigroup", InstitutionSlug: "citigroup", Kind: "bank_broker", PresentPct: 6.3},
			{StockCode: "BHP", HolderKey: "vanguard", InstitutionSlug: "vanguard", Kind: "index_manager", PresentPct: 5.1},
			{StockCode: "MIN", HolderKey: "name:chris ellison", Kind: "unclassified", PresentPct: 12},
			{StockCode: "WC8", HolderKey: "asx:MIN", Kind: "corporate", PresentPct: 14.6},
		},
		stats: &shortsstore.NoticeStats{Parsed: 9, Withheld: 2, LatestAnnounced: "2026-10-16",
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
			"PLS": {Pct: 12, Issued: 3.2e9},
			"BHP": {Pct: 0.5, Issued: 5.07e9},
			"MIN": {Pct: 6, Issued: 2e8},
		},
		companies: map[string]shortsstore.OwnershipCompany{
			"PLS": {Name: "PLS Group", Industry: "Materials"},
			"BHP": {Name: "BHP Group", Industry: "Materials", MarketCap: new(3e11)},
		},
	}
}

func TestBuildOwnershipOverview(t *testing.T) {
	out := buildOwnershipOverview(ownershipFixture())

	// Crowded counts institutions only: MIN's and WC8's holders are a person
	// and a company.
	require.Len(t, out.Crowded, 2)
	assert.Equal(t, "PLS", out.Crowded[0].StockCode, "hedge fund + active manager 11.5% beats bank + index 11.4%")
	codes := []string{out.Crowded[0].StockCode, out.Crowded[1].StockCode}
	assert.ElementsMatch(t, []string{"BHP", "PLS"}, codes)

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
	assert.EqualValues(t, 2, out.NoticesWithheld)

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
	assert.Equal(t, "substantial_notices", out.Sources[0].Source)
}

func TestBuildInstitutionList(t *testing.T) {
	d := ownershipFixture()
	all := buildInstitutionList(d, "", "", 200, 0)
	assert.EqualValues(t, 5, all.Total)
	// Positions first, then assets: Hostplus has none but the largest AUM.
	assert.Equal(t, "hostplus", all.Institutions[len(all.Institutions)-1].Slug)
	hedge := buildInstitutionList(d, "hedge_fund", "", 200, 0)
	require.Len(t, hedge.Institutions, 1)
	assert.Equal(t, "regal-partners", hedge.Institutions[0].Slug)
	found := buildInstitutionList(d, "", "vang", 200, 0)
	require.Len(t, found.Institutions, 1)
	paged := buildInstitutionList(d, "", "", 2, 4)
	assert.Len(t, paged.Institutions, 1)
	assert.EqualValues(t, 5, paged.Total)
}

func TestBuildInstitutionAndStock(t *testing.T) {
	d := ownershipFixture()
	inst := buildInstitution(d, "citigroup")
	require.NotNil(t, inst.Institution)
	assert.EqualValues(t, 3, inst.Institution.Notices)
	assert.Nil(t, buildInstitution(d, "nobody").Institution)

	stock := buildStockOwnership(d, "BHP")
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
	// A stock with no ownership data still names itself and its short interest.
	none := buildStockOwnership(d, "MIN")
	require.NotNil(t, none.Summary)
	assert.Equal(t, "MIN", none.Summary.StockCode)
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
