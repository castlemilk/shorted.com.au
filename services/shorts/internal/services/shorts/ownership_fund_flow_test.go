package shorts

import (
	"context"
	"fmt"
	"testing"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// fundFlowSnapshots: Vanguard's VAS has three monthly files, so a window
// compares it; BlackRock's IOZ has one file, so no window compares it; a
// Hostplus super option has one semi-annual file.
func fundFlowSnapshots() []shortsstore.FundSnapshotRow {
	return []shortsstore.FundSnapshotRow{
		{ID: 1, InstitutionSlug: "vanguard", FundName: "VAS", FundCode: "VAS", SourceKind: "etf", AsAt: "2026-08-31"},
		{ID: 2, InstitutionSlug: "vanguard", FundName: "VAS", FundCode: "VAS", SourceKind: "etf", AsAt: "2026-09-30"},
		{ID: 3, InstitutionSlug: "vanguard", FundName: "VAS", FundCode: "VAS", SourceKind: "etf", AsAt: "2026-10-31"},
		{ID: 4, InstitutionSlug: "blackrock", FundName: "IOZ", FundCode: "IOZ", SourceKind: "etf", AsAt: "2026-10-15"},
		{ID: 5, InstitutionSlug: "hostplus", FundName: "Balanced", SourceKind: "super_phd", AsAt: "2026-06-30"},
	}
}

// fundFlowHoldings: VAS grows BHP from 100M to 110M shares at a falling price,
// exits PLS and buys CBA. Units are nil on a row that states only a value.
func fundFlowHoldings() map[int64][]shortsstore.FundSnapshotHoldingRow {
	row := func(id int64, code string, units, value *float64) shortsstore.FundSnapshotHoldingRow {
		return shortsstore.FundSnapshotHoldingRow{SnapshotID: id, StockCode: code, Units: units, Value: value}
	}
	return map[int64][]shortsstore.FundSnapshotHoldingRow{
		1: {row(1, "BHP", new(100e6), new(4.5e9)), row(1, "PLS", new(50e6), new(1e8))},
		2: {row(2, "BHP", new(105e6), new(4.6e9)), row(2, "PLS", new(40e6), new(0.9e8))},
		3: {row(3, "BHP", new(110e6), new(4.4e9)), row(3, "CBA", new(2e6), new(3e8))},
		4: {row(4, "BHP", new(18e6), new(7.2e8))},
		5: {row(5, "BHP", new(26e6), new(1.5e9)), row(5, "PLS", nil, new(2e8))},
	}
}

// fakeFundFlowReader computes what the Postgres reads compute, from the
// fixture's files, and records the pairs it was asked for.
type fakeFundFlowReader struct {
	holdings map[int64][]shortsstore.FundSnapshotHoldingRow
	pairs    [][]shortsstore.FundSnapshotPair
}

func (f *fakeFundFlowReader) FundSnapshotHoldings(_ context.Context, ids []int64, code string) ([]shortsstore.FundSnapshotHoldingRow, error) {
	var out []shortsstore.FundSnapshotHoldingRow
	for _, id := range ids {
		for _, r := range f.holdings[id] {
			if code == "" || r.StockCode == code {
				out = append(out, r)
			}
		}
	}
	return out, nil
}

func (f *fakeFundFlowReader) FundHoldingChanges(_ context.Context, pairs []shortsstore.FundSnapshotPair, codes []string) ([]shortsstore.FundHoldingChangeRow, error) {
	f.pairs = append(f.pairs, pairs)
	allowed := map[string]bool{}
	for _, c := range codes {
		allowed[c] = true
	}
	type key struct {
		g    int32
		code string
	}
	acc := map[key]*shortsstore.FundHoldingChangeRow{}
	add := func(g int32, r shortsstore.FundSnapshotHoldingRow, later bool) {
		if len(codes) > 0 && !allowed[r.StockCode] {
			return
		}
		k := key{g, r.StockCode}
		c := acc[k]
		if c == nil {
			c = &shortsstore.FundHoldingChangeRow{Group: g, StockCode: r.StockCode}
			acc[k] = c
		}
		if later {
			c.RowTo = true
		} else {
			c.RowFrom = true
		}
		value := 0.0
		if r.Value != nil {
			value = *r.Value
		}
		switch {
		case r.Units != nil && later:
			c.UnitsTo += *r.Units
			c.HasUnitsTo = true
			if r.Value != nil {
				c.PricedUnitsTo += *r.Units
				c.UnitValueTo += value
			}
		case r.Units != nil:
			c.UnitsFrom += *r.Units
			c.HasUnitsFrom = true
			if r.Value != nil {
				c.PricedUnitsFrom += *r.Units
				c.UnitValueFrom += value
			}
		case later:
			c.ValueOnlyTo += value
		default:
			c.ValueOnlyFrom += value
		}
	}
	for _, p := range pairs {
		for _, r := range f.holdings[p.From] {
			add(p.Group, r, false)
		}
		for _, r := range f.holdings[p.To] {
			add(p.Group, r, true)
		}
	}
	var out []shortsstore.FundHoldingChangeRow
	for _, c := range acc {
		out = append(out, *c)
	}
	return out, nil
}

// fundFlowDeskStore is the desk fake with the fund file reads beside it, so the
// map finds them by type assertion as it finds the Postgres store.
type fundFlowDeskStore struct {
	*deskStore
	*fakeFundFlowReader
	snaps []shortsstore.FundSnapshotRow
}

func (f *fundFlowDeskStore) FundSnapshots(context.Context) ([]shortsstore.FundSnapshotRow, error) {
	return f.snaps, nil
}

func fundFlowDeskServer(snaps []shortsstore.FundSnapshotRow, holdings map[int64][]shortsstore.FundSnapshotHoldingRow) *ShortsServer {
	ds := deskTestStore(deskNotices())
	s, _ := deskServer(ds)
	s.ownershipStore = &fundFlowDeskStore{deskStore: ds, fakeFundFlowReader: &fakeFundFlowReader{holdings: holdings}, snaps: snaps}
	return s
}

func fundFlowFundNamed(idx *fundIndex, name string) *fundFlowFund {
	for _, f := range idx.funds {
		if f.name == name {
			return f
		}
	}
	return nil
}

func TestFundFlowStartsFromTheFileAtTheWindowOrTheFirstInside(t *testing.T) {
	idx := newFundIndex(fundFlowSnapshots())
	vas := fundFlowFundNamed(idx, "VAS")
	require.NotNil(t, vas)
	assert.Nil(t, vas.at("2026-08-30"))
	assert.Equal(t, int64(1), vas.at("2026-08-31").ID)
	assert.Equal(t, int64(2), vas.at("2026-10-30").ID)
	assert.Equal(t, int64(2), vas.startIn("2026-10-01", "2026-10-31").ID, "the newest file on or before the start")
	assert.Equal(t, int64(1), vas.startIn("2026-08-03", "2026-10-31").ID, "else the first file inside the window")
	assert.Nil(t, vas.startIn("2026-01-01", "2026-02-01"), "no file at or inside the window")
}

func TestPairsForComparesEachIndexFundWithItself(t *testing.T) {
	idx := newFundIndex(fundFlowSnapshots())
	w := idx.pairsFor("2026-08-03", "2026-10-31")
	assert.Equal(t, 1, w.compared, "IOZ's one file inside the window is never new money")
	assert.Equal(t, []shortsstore.FundSnapshotPair{{Group: windowGroup, From: 1, To: 3}}, w.pairs)
	assert.ElementsMatch(t, []int64{3, 4}, w.endIDs, "the index funds' end files only, the super option excluded")
	assert.Equal(t, "2026-08-31", w.startFrom)
	assert.Equal(t, "2026-08-31", w.startTo)
	assert.Equal(t, "2026-10-15", w.endFrom)
	assert.Equal(t, "2026-10-31", w.endTo)
}

func TestComputeIndexFundsValuesTheChangeAtTheLaterPrice(t *testing.T) {
	idx := newFundIndex(fundFlowSnapshots())
	reader := &fakeFundFlowReader{holdings: fundFlowHoldings()}
	figs, err := computeIndexFunds(context.Background(), idx, reader, "2026-08-03", "2026-10-31")
	require.NoError(t, err)
	assert.Equal(t, 1, figs.fundsCompared)

	bhp := figs.stocks["BHP"]
	require.NotNil(t, bhp)
	assert.True(t, bhp.hasValue)
	assert.InDelta(t, 4.4e9+7.2e8, bhp.value, 1, "every index fund's end file, compared or not")
	assert.True(t, bhp.hasFlow)
	assert.InDelta(t, 4e8, bhp.flow, 1, "10M more shares at the end file's price of 40")
	assert.InDelta(t, 4e9, bhp.startAtEnd, 1, "100M starting shares at the same price")

	pls := figs.stocks["PLS"]
	require.NotNil(t, pls)
	assert.False(t, pls.hasValue, "no index fund holds it at the end")
	assert.InDelta(t, -1e8, pls.flow, 1, "a position gone is valued at its last price")
	assert.InDelta(t, 1e8, pls.startAtEnd, 1)

	cba := figs.stocks["CBA"]
	require.NotNil(t, cba)
	assert.InDelta(t, 3e8, cba.flow, 1)
	assert.Zero(t, cba.startAtEnd, "a new position has no starting shares to compare")
}

func TestOneFilePerFundHasNoChange(t *testing.T) {
	snaps := []shortsstore.FundSnapshotRow{fundFlowSnapshots()[2], fundFlowSnapshots()[3]}
	idx := newFundIndex(snaps)
	figs, err := computeIndexFunds(context.Background(), idx, &fakeFundFlowReader{holdings: fundFlowHoldings()}, "2026-10-01", "2026-10-31")
	require.NoError(t, err)
	assert.Zero(t, figs.fundsCompared)
	assert.Empty(t, figs.startFrom)
	for code, s := range figs.stocks {
		assert.False(t, s.hasFlow, "%s: one file is a level, never a change", code)
	}
	assert.True(t, figs.stocks["BHP"].hasValue, "the level is still drawn")
}

func TestMapCarriesTheIndexFundFiguresOfItsWindow(t *testing.T) {
	s := fundFlowDeskServer(fundFlowSnapshots(), fundFlowHoldings())
	resp, err := s.GetOwnershipMap(context.Background(), connect.NewRequest(&shortsv1alpha1.GetOwnershipMapRequest{From: "2026-07-18", To: "2026-10-16"}))
	require.NoError(t, err)
	out := resp.Msg
	assert.EqualValues(t, 1, out.FundsCompared)
	assert.Equal(t, "2026-08-31", out.StartFilesFrom, "VAS's first file inside the window is its start, not new money")
	assert.Equal(t, "2026-08-31", out.StartFilesTo)
	assert.Equal(t, "2026-09-30", out.EndFilesFrom, "VAS's newest file at the window's end, IOZ's too")
	assert.Equal(t, "2026-10-15", out.EndFilesTo)

	byCode := map[string]*shortsv1alpha1.MapStock{}
	for _, m := range out.Stocks {
		byCode[m.StockCode] = m
	}
	bhp := byCode["BHP"]
	require.NotNil(t, bhp)
	assert.True(t, bhp.HasFundValue)
	assert.InDelta(t, 4.6e9+7.2e8, bhp.FundValueAud, 1)
	assert.True(t, bhp.HasFundFlow)
	assert.InDelta(t, 5e6*4.6e9/105e6, bhp.FundFlowAud, 1, "five million shares at the end file's price, not the new value of the position")
	assert.True(t, bhp.HasFundChange)
	assert.InDelta(t, 5, bhp.FundChangePct, 1e-9, "five million over the 100M starting shares, both at the end price")

	pls := byCode["PLS"]
	require.NotNil(t, pls)
	assert.True(t, pls.HasFundFlow)
	assert.InDelta(t, -2.25e7, pls.FundFlowAud, 1)
	assert.InDelta(t, -20, pls.FundChangePct, 1e-9)

	minStock := byCode["MIN"]
	require.NotNil(t, minStock)
	assert.False(t, minStock.HasFundValue, "no tracked fund holds it: no figure, not zero")
	assert.False(t, minStock.HasFundFlow)
	assert.False(t, minStock.HasFundChange)
}

func TestMapWithOneFilePerFundStatesLevelsOnly(t *testing.T) {
	snaps := []shortsstore.FundSnapshotRow{fundFlowSnapshots()[3]}
	s := fundFlowDeskServer(snaps, fundFlowHoldings())
	resp, err := s.GetOwnershipMap(context.Background(), connect.NewRequest(&shortsv1alpha1.GetOwnershipMapRequest{From: "2026-07-18", To: "2026-10-16"}))
	require.NoError(t, err)
	assert.Zero(t, resp.Msg.FundsCompared)
	assert.Empty(t, resp.Msg.StartFilesFrom)
	for _, m := range resp.Msg.Stocks {
		assert.False(t, m.HasFundFlow, "%s", m.StockCode)
		assert.False(t, m.HasFundChange, "%s", m.StockCode)
	}
	var bhp *shortsv1alpha1.MapStock
	for _, m := range resp.Msg.Stocks {
		if m.StockCode == "BHP" {
			bhp = m
		}
	}
	require.NotNil(t, bhp)
	assert.True(t, bhp.HasFundValue)
	assert.InDelta(t, 7.2e8, bhp.FundValueAud, 1)
}

func TestBuildStockFundSeriesCarriesUnits(t *testing.T) {
	u := ownershipFixtureUniverse()
	rows := []shortsstore.FundSeriesRow{
		{InstitutionSlug: "vanguard", FundName: "VAS", FundCode: "VAS", SourceKind: "etf", AsAt: "2026-08-31", Weight: new(2.1), Value: new(4.5e9), Units: new(100e6)},
		{InstitutionSlug: "vanguard", FundName: "VAS", FundCode: "VAS", SourceKind: "etf", AsAt: "2026-09-30", Weight: new(2.2), Value: new(4.6e9)},
	}
	out := buildStockFundSeries(u, nil, "BHP", rows)
	require.Len(t, out.Funds, 1)
	pts := out.Funds[0].Points
	require.Len(t, pts, 2)
	assert.True(t, pts[0].HasUnits)
	assert.InDelta(t, 100e6, pts[0].Units, 1)
	assert.False(t, pts[1].HasUnits, "a row that states no units has none, not zero")
	assert.Zero(t, pts[1].Units)
}

func TestFlowPositionsListTheTenLargestHoldersOnly(t *testing.T) {
	u := ownershipFixtureUniverse()
	bhpIndustry := u.data.companies["BHP"].Industry
	for i := range 12 {
		u.data.holdings = append(u.data.holdings, shortsstore.SubstantialHoldingRow{
			StockCode: "BHP", HolderKey: fmt.Sprintf("fund-%02d", i), HolderName: fmt.Sprintf("Fund %02d", i),
			Kind: "hedge_fund", Form: "604", PresentPct: float64(i + 1),
		})
	}
	out := buildOwnershipFlows(u, "2026-07-18", "2026-10-16", nil)
	var cell *shortsv1alpha1.FlowPosition
	for _, p := range out.Positions {
		if p.Kind == "hedge_fund" && p.Industry == bhpIndustry {
			cell = p
		}
	}
	require.NotNil(t, cell)
	require.Len(t, cell.TopHolders, flowTopHolders, "at most ten holders per position")
	assert.Equal(t, "fund-11", cell.TopHolders[0].Slug, "the largest exposure first")
	assert.Equal(t, "fund-02", cell.TopHolders[9].Slug, "the twelve holders' ten largest, the two smallest left out")
	assert.True(t, cell.TopHolders[0].HasExposure)
	for i := 1; i < len(cell.TopHolders); i++ {
		assert.GreaterOrEqual(t, cell.TopHolders[i-1].ExposureAud, cell.TopHolders[i].ExposureAud)
	}
	assert.EqualValues(t, 1, cell.TopHolders[0].Holdings)
}

// A fund whose end file states BHP's units but no value adds no price: the
// change has none, so it sets no figure and the map says so.
func TestUnpricedEndRowSetsNoFundFlow(t *testing.T) {
	row := func(id int64, code string, units, value *float64) shortsstore.FundSnapshotHoldingRow {
		return shortsstore.FundSnapshotHoldingRow{SnapshotID: id, StockCode: code, Units: units, Value: value}
	}
	holdings := map[int64][]shortsstore.FundSnapshotHoldingRow{
		1: {row(1, "BHP", new(100e6), new(4.5e9))},
		3: {row(3, "BHP", new(110e6), nil)},
	}
	idx := newFundIndex(fundFlowSnapshots())
	figs, err := computeIndexFunds(context.Background(), idx, &fakeFundFlowReader{holdings: holdings}, "2026-08-03", "2026-10-31")
	require.NoError(t, err)
	assert.Equal(t, 1, figs.fundsCompared)

	bhp := figs.stocks["BHP"]
	require.NotNil(t, bhp, "the stock is in a compared fund")
	assert.False(t, bhp.hasFlow, "no priced end row: no price, so no flow")
	assert.False(t, bhp.hasValue, "no stated value at the end")
	assert.Zero(t, bhp.startAtEnd)

	out := buildOwnershipMap(ownershipFixtureUniverse(), "2026-08-03", "2026-10-31", "2026-08-03", "2026-10-31", nil, figs)
	for _, m := range out.Stocks {
		if m.StockCode == "BHP" {
			assert.False(t, m.HasFundFlow, "has_fund_flow stays false")
			assert.False(t, m.HasFundChange, "has_fund_change stays false")
		}
	}
}

// Shares a fund states at the end without a value have no price of their own
// there, so that fund is left out of the flow and the start (its shares are not
// read at another fund's price); the priced fund's change stands alone.
func TestUnpricedRowSharesAreLeftOutOfTheFlow(t *testing.T) {
	snaps := append(fundFlowSnapshots(),
		shortsstore.FundSnapshotRow{ID: 6, InstitutionSlug: "statesuper", FundName: "SFW", FundCode: "SFW", SourceKind: "etf", AsAt: "2026-08-31"},
		shortsstore.FundSnapshotRow{ID: 7, InstitutionSlug: "statesuper", FundName: "SFW", FundCode: "SFW", SourceKind: "etf", AsAt: "2026-10-31"},
	)
	holdings := fundFlowHoldings()
	holdings[6] = []shortsstore.FundSnapshotHoldingRow{{SnapshotID: 6, StockCode: "BHP", Units: new(50e6), Value: new(2e9)}}
	holdings[7] = []shortsstore.FundSnapshotHoldingRow{{SnapshotID: 7, StockCode: "BHP", Units: new(60e6)}}
	idx := newFundIndex(snaps)
	figs, err := computeIndexFunds(context.Background(), idx, &fakeFundFlowReader{holdings: holdings}, "2026-08-03", "2026-10-31")
	require.NoError(t, err)
	assert.Equal(t, 2, figs.fundsCompared)

	bhp := figs.stocks["BHP"]
	require.NotNil(t, bhp)
	assert.True(t, bhp.hasFlow)
	assert.InDelta(t, 4e8, bhp.flow, 1, "VAS's 10M more shares at its own end price of 40; SFW's 10M are unpriced at its end")
	assert.InDelta(t, 4e9, bhp.startAtEnd, 1, "VAS's 100M starting shares at 40, and SFW's 50M left out with its change")
}

// The fund figures read the fund window, not the notice window (spec 14.10).
func TestMapFundWindowIsSeparateFromTheNoticeWindow(t *testing.T) {
	s := fundFlowDeskServer(fundFlowSnapshots(), fundFlowHoldings())
	resp, err := s.GetOwnershipMap(context.Background(), connect.NewRequest(&shortsv1alpha1.GetOwnershipMapRequest{
		From: "2026-07-18", To: "2026-10-16", FundFrom: "2026-08-03", FundTo: "2026-10-31",
	}))
	require.NoError(t, err)
	assert.Equal(t, "2026-07-18", resp.Msg.From)
	assert.Equal(t, "2026-10-16", resp.Msg.To)
	assert.Equal(t, "2026-08-03", resp.Msg.FundFrom, "the served fund window")
	assert.Equal(t, "2026-10-31", resp.Msg.FundTo)
	assert.EqualValues(t, 1, resp.Msg.FundsCompared)
	assert.Equal(t, "2026-10-31", resp.Msg.EndFilesTo, "VAS's October file, past the notice window's end")

	_, err = s.GetOwnershipMap(context.Background(), connect.NewRequest(&shortsv1alpha1.GetOwnershipMapRequest{
		FundFrom: "2025-01-01", FundTo: "2026-10-31",
	}))
	require.Error(t, err)
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
}

func TestFlowHolderMarksAHolderWithNoInstitution(t *testing.T) {
	u := ownershipFixtureUniverse()
	u.data.holdings = append(u.data.holdings, shortsstore.SubstantialHoldingRow{
		StockCode: "BHP", HolderKey: "no-page-holder", HolderName: "No Page Holder",
		Kind: "hedge_fund", Form: "604", PresentPct: 1,
	})
	out := buildOwnershipFlows(u, "2026-07-18", "2026-10-16", nil)
	var found *shortsv1alpha1.FlowHolder
	for _, p := range out.Positions {
		for _, h := range p.TopHolders {
			if h.Slug == "no-page-holder" {
				found = h
			}
		}
	}
	require.NotNil(t, found)
	assert.False(t, found.HasInstitution, "its slug is a holder key")
}
