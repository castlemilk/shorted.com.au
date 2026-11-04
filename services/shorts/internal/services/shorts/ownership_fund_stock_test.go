package shorts

import (
	"context"
	"testing"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// stockFundIdx is the fund index of the fixture files, and the reader of its
// holdings, for the per-fund comparisons.
func stockFundIdx(t *testing.T) (*fundIndex, *fakeFundFlowReader) {
	t.Helper()
	return newFundIndex(fundFlowSnapshots()), &fakeFundFlowReader{holdings: fundFlowHoldings()}
}

// The window 2026-08-03 to 2026-10-31: VAS is compared from its first file in the
// window (August) with its newest file (October); IOZ has one file, so it is not.
func TestStockFundChangesComparesEachFundWithItself(t *testing.T) {
	idx, reader := stockFundIdx(t)
	changes, err := stockFundChanges(context.Background(), idx, reader, "BHP", "2026-08-03", "2026-10-31")
	require.NoError(t, err)

	vas := changes["vanguard|VAS"]
	assert.True(t, vas.hasStartDate)
	assert.Equal(t, "2026-08-31", vas.startDate, "its first file inside the window, not new money")
	assert.True(t, vas.hasStartUnits)
	assert.InDelta(t, 100e6, vas.startUnits, 1)
	assert.True(t, vas.hasEndDate)
	assert.Equal(t, "2026-10-31", vas.endDate)
	assert.True(t, vas.hasEndUnits)
	assert.InDelta(t, 110e6, vas.endUnits, 1)
	assert.True(t, vas.hasUnitsChange)
	assert.InDelta(t, 10e6, vas.unitsChange, 1)
	assert.True(t, vas.hasChangeValueAUD)
	assert.InDelta(t, 4e8, vas.changeValueAUD, 1, "ten million shares at the end file's price of 40")

	ioz := changes["blackrock|IOZ"]
	assert.False(t, ioz.hasStartDate, "one file inside the window: no earlier file to compare")
	assert.False(t, ioz.hasUnitsChange)
	assert.False(t, ioz.hasChangeValueAUD)
	assert.True(t, ioz.hasEndDate)
	assert.Equal(t, "2026-10-15", ioz.endDate)
	assert.InDelta(t, 18e6, ioz.endUnits, 1, "its end figures are still stated")

	_, ok := changes["hostplus|Balanced"]
	assert.False(t, ok, "a super option is not compared")
}

// PLS left VAS between the files: its change is the whole holding, valued at the
// price its start file gives, since the end file has no price for it.
func TestStockFundChangesValuesAPositionLeftAtItsStartPrice(t *testing.T) {
	idx, reader := stockFundIdx(t)
	changes, err := stockFundChanges(context.Background(), idx, reader, "PLS", "2026-08-03", "2026-10-31")
	require.NoError(t, err)
	vas := changes["vanguard|VAS"]
	assert.True(t, vas.hasEndUnits)
	assert.Zero(t, vas.endUnits, "the October file states no PLS: it holds none there")
	assert.True(t, vas.hasUnitsChange)
	assert.InDelta(t, -50e6, vas.unitsChange, 1)
	assert.True(t, vas.hasChangeValueAUD)
	assert.InDelta(t, -1e8, vas.changeValueAUD, 1, "fifty million shares at the start file's price of 2")
}

// CBA entered VAS between the files: the start holds none, so the change is the
// whole holding, at the end file's price.
func TestStockFundChangesStatesAPositionThatEnters(t *testing.T) {
	idx, reader := stockFundIdx(t)
	changes, err := stockFundChanges(context.Background(), idx, reader, "CBA", "2026-08-03", "2026-10-31")
	require.NoError(t, err)
	vas := changes["vanguard|VAS"]
	assert.True(t, vas.hasStartUnits)
	assert.Zero(t, vas.startUnits, "the August file states no CBA: it holds none there")
	assert.True(t, vas.hasUnitsChange)
	assert.InDelta(t, 2e6, vas.unitsChange, 1)
	assert.True(t, vas.hasChangeValueAUD)
	assert.InDelta(t, 3e8, vas.changeValueAUD, 1, "two million shares at the end file's price of 150")
}

func TestStockFundChangesHasNoComparisonForOneFile(t *testing.T) {
	idx := newFundIndex(fundFlowSnapshots()[3:4])
	changes, err := stockFundChanges(context.Background(), idx, &fakeFundFlowReader{holdings: fundFlowHoldings()}, "BHP", "2026-08-03", "2026-10-31")
	require.NoError(t, err)
	ioz := changes["blackrock|IOZ"]
	assert.False(t, ioz.hasStartDate)
	assert.False(t, ioz.hasStartUnits)
	assert.False(t, ioz.hasUnitsChange)
	assert.True(t, ioz.hasEndUnits)
}

// A stock whose end file states a value without units is not a share change: the
// fund's comparison has no units change, and the stock counts only in its value.
func TestValueOnlyEndRowCountsOnlyInFundValue(t *testing.T) {
	holdings := fundFlowHoldings()
	holdings[3] = []shortsstore.FundSnapshotHoldingRow{
		{SnapshotID: 3, StockCode: "BHP", Value: new(4.4e9)},
		{SnapshotID: 3, StockCode: "CBA", Units: new(2e6), Value: new(3e8)},
	}
	idx := newFundIndex(fundFlowSnapshots())
	figs, err := computeIndexFunds(context.Background(), idx, &fakeFundFlowReader{holdings: holdings}, "2026-08-03", "2026-10-31")
	require.NoError(t, err)

	bhp := figs.stocks["BHP"]
	require.NotNil(t, bhp)
	assert.False(t, bhp.hasFlow, "a value-only end row sets no flow")
	assert.Zero(t, bhp.startAtEnd)
	assert.True(t, bhp.hasValue)
	assert.InDelta(t, 4.4e9+7.2e8, bhp.value, 1, "the value still counts in the holdings at the end")
	assert.InDelta(t, 3e8, figs.stocks["CBA"].value, 1)
	assert.True(t, figs.stocks["CBA"].hasFlow, "CBA states units at the end, so its change is a share change")
}

// The row's rule itself: a row is left out when it states no units on either side
// or a value without units on one side, and a units change is valued at the price
// the priced rows give.
func TestChangeFlowLeavesOutAValueOnlyRow(t *testing.T) {
	_, _, ok := changeFlow(shortsstore.FundHoldingChangeRow{ValueOnlyFrom: 1e9, ValueOnlyTo: 2e9})
	assert.False(t, ok, "a value on each side and no units: left out")

	_, _, ok = changeFlow(shortsstore.FundHoldingChangeRow{
		UnitsFrom: 100, HasUnitsFrom: true, PricedUnitsFrom: 100, UnitValueFrom: 4000,
		RowTo: true, ValueOnlyTo: 5e8,
	})
	assert.False(t, ok, "units at the start and only a value at the end: no share change to read")

	_, _, ok = changeFlow(shortsstore.FundHoldingChangeRow{
		UnitsTo: 40, HasUnitsTo: true, PricedUnitsTo: 40, UnitValueTo: 1600,
		RowFrom: true, ValueOnlyFrom: 5e8,
	})
	assert.False(t, ok, "only a value at the start and units at the end: left out too")

	// A value-only row stating no value at all is still a row with no shares: it is
	// left out, not read as a holding of none (the map and the stock inspector agree).
	_, _, ok = changeFlow(shortsstore.FundHoldingChangeRow{
		UnitsFrom: 100, HasUnitsFrom: true, PricedUnitsFrom: 100, UnitValueFrom: 4000,
		RowTo: true,
	})
	assert.False(t, ok, "a row with neither units nor value at the end: left out")

	// No row at the end is a holding of none, so the start's units are the whole change.
	goneFlow, goneStart, goneOK := changeFlow(shortsstore.FundHoldingChangeRow{
		UnitsFrom: 100, HasUnitsFrom: true, PricedUnitsFrom: 100, UnitValueFrom: 4000, RowFrom: true,
	})
	require.True(t, goneOK, "no row at the end holds none there, so the position is gone")
	assert.InDelta(t, -4000, goneFlow, 1e-9)
	assert.InDelta(t, 4000, goneStart, 1e-9)

	flow, startAtEnd, ok := changeFlow(shortsstore.FundHoldingChangeRow{
		UnitsFrom: 100, UnitsTo: 110, HasUnitsFrom: true, HasUnitsTo: true,
		PricedUnitsFrom: 100, UnitValueFrom: 4000, PricedUnitsTo: 110, UnitValueTo: 4400,
	})
	require.True(t, ok)
	assert.InDelta(t, 400, flow, 1e-9, "ten shares at the end price of 40")
	assert.InDelta(t, 4000, startAtEnd, 1e-9)
}

// A stock with units but no value on the later row gets no price, so it has no
// flow, and a stock whose price comes from the start row still has one.
func TestChangeFlowPricesAPositionLeftFromItsStartRow(t *testing.T) {
	flow, startAtEnd, ok := changeFlow(shortsstore.FundHoldingChangeRow{
		UnitsFrom: 50, HasUnitsFrom: true, PricedUnitsFrom: 50, UnitValueFrom: 100,
	})
	require.True(t, ok)
	assert.InDelta(t, -100, flow, 1e-9, "fifty shares at the start price of 2")
	assert.InDelta(t, 100, startAtEnd, 1e-9)
}

// The stock inspector's fund series carries each fund's comparison: the VAS line
// is compared, IOZ's start is unknown, and a super option has none.
func TestGetStockFundSeriesCarriesEachFundsComparison(t *testing.T) {
	ds := deskTestStore(deskNotices())
	ds.series = []shortsstore.FundSeriesRow{
		{InstitutionSlug: "vanguard", FundName: "VAS", FundCode: "VAS", SourceKind: "etf", AsAt: "2026-08-31", Units: new(100e6), Value: new(4.5e9)},
		{InstitutionSlug: "vanguard", FundName: "VAS", FundCode: "VAS", SourceKind: "etf", AsAt: "2026-09-30", Units: new(105e6), Value: new(4.6e9)},
		{InstitutionSlug: "vanguard", FundName: "VAS", FundCode: "VAS", SourceKind: "etf", AsAt: "2026-10-31", Units: new(110e6), Value: new(4.4e9)},
		{InstitutionSlug: "blackrock", FundName: "IOZ", FundCode: "IOZ", SourceKind: "etf", AsAt: "2026-10-15", Units: new(18e6), Value: new(7.2e8)},
		{InstitutionSlug: "hostplus", FundName: "Balanced", SourceKind: "super_phd", AsAt: "2026-06-30", Units: new(26e6)},
	}
	s, _ := deskServer(ds)
	s.ownershipStore = &fundFlowDeskStore{deskStore: ds, fakeFundFlowReader: &fakeFundFlowReader{holdings: fundFlowHoldings()}, snaps: fundFlowSnapshots()}

	resp, err := s.GetStockFundSeries(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStockFundSeriesRequest{
		StockCode: "BHP", FundFrom: "2026-08-03", FundTo: "2026-10-31",
	}))
	require.NoError(t, err)
	assert.Equal(t, "2026-08-03", resp.Msg.FundFrom)
	assert.Equal(t, "2026-10-31", resp.Msg.FundTo)

	byName := map[string]*shortsv1alpha1.FundSeries{}
	for _, f := range resp.Msg.Funds {
		byName[f.FundName] = f
	}
	vas := byName["VAS"]
	require.NotNil(t, vas)
	assert.True(t, vas.HasStartDate)
	assert.Equal(t, "2026-08-31", vas.StartDate)
	assert.True(t, vas.HasStartUnits)
	assert.InDelta(t, 100e6, vas.StartUnits, 1)
	assert.Equal(t, "2026-10-31", vas.EndDate)
	assert.InDelta(t, 110e6, vas.EndUnits, 1)
	assert.True(t, vas.HasUnitsChange)
	assert.InDelta(t, 10e6, vas.UnitsChange, 1)
	assert.True(t, vas.HasChangeValueAud)
	assert.InDelta(t, 4e8, vas.ChangeValueAud, 1)

	ioz := byName["IOZ"]
	require.NotNil(t, ioz)
	assert.False(t, ioz.HasStartDate)
	assert.False(t, ioz.HasUnitsChange, "its one file is a level, never a change")
	assert.False(t, ioz.HasChangeValueAud)
	assert.True(t, ioz.HasEndUnits)

	balanced := byName["Balanced"]
	require.NotNil(t, balanced)
	assert.False(t, balanced.HasStartDate, "a super option has no comparison")
	assert.False(t, balanced.HasUnitsChange)
	assert.False(t, balanced.HasEndUnits)

	_, err = s.GetStockFundSeries(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStockFundSeriesRequest{
		StockCode: "BHP", FundFrom: "2025-01-01", FundTo: "2026-10-31",
	}))
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
}

// A value-only end row stating no value is a row with no shares, so the stock's
// per-fund change is unknown, as the map leaves it out of the flow.
func TestStockFundChangeLeavesOutAValueOnlyZeroRow(t *testing.T) {
	holdings := fundFlowHoldings()
	holdings[3] = []shortsstore.FundSnapshotHoldingRow{
		{SnapshotID: 3, StockCode: "BHP", Value: new(0.0)},
	}
	idx := newFundIndex(fundFlowSnapshots())
	changes, err := stockFundChanges(context.Background(), idx, &fakeFundFlowReader{holdings: holdings}, "BHP", "2026-08-03", "2026-10-31")
	require.NoError(t, err)
	vas := changes["vanguard|VAS"]
	assert.False(t, vas.hasEndUnits, "the end row states a value and no units")
	assert.False(t, vas.hasUnitsChange)
	assert.False(t, vas.hasChangeValueAUD)
}

// A zero share change with no priced row at the end has no value, as the map has
// none for it: has_ false, not a figure of zero.
func TestStockFundChangeZeroSharesNeedsAPricedRow(t *testing.T) {
	holdings := fundFlowHoldings()
	holdings[3] = []shortsstore.FundSnapshotHoldingRow{
		{SnapshotID: 3, StockCode: "BHP", Units: new(100e6)},
	}
	idx := newFundIndex(fundFlowSnapshots())
	changes, err := stockFundChanges(context.Background(), idx, &fakeFundFlowReader{holdings: holdings}, "BHP", "2026-08-03", "2026-10-31")
	require.NoError(t, err)
	vas := changes["vanguard|VAS"]
	assert.True(t, vas.hasUnitsChange)
	assert.Zero(t, vas.unitsChange)
	assert.False(t, vas.hasChangeValueAUD, "no priced end row: the change has no price")
}

// The per-fund changes of one stock sum to the map's fund_flow_aud for it: each
// fund's line is read by the same pairs and the same rule.
func TestStockFundChangesSumToTheMapsFundFlow(t *testing.T) {
	snaps := append(fundFlowSnapshots(),
		shortsstore.FundSnapshotRow{ID: 6, InstitutionSlug: "statesuper", FundName: "SFW", FundCode: "SFW", SourceKind: "etf", AsAt: "2026-08-31"},
		shortsstore.FundSnapshotRow{ID: 7, InstitutionSlug: "statesuper", FundName: "SFW", FundCode: "SFW", SourceKind: "etf", AsAt: "2026-10-31"},
	)
	holdings := fundFlowHoldings()
	holdings[6] = []shortsstore.FundSnapshotHoldingRow{{SnapshotID: 6, StockCode: "BHP", Units: new(50e6), Value: new(2e9)}}
	holdings[7] = []shortsstore.FundSnapshotHoldingRow{{SnapshotID: 7, StockCode: "BHP", Units: new(60e6), Value: new(2.4e9)}}
	idx := newFundIndex(snaps)
	reader := &fakeFundFlowReader{holdings: holdings}

	changes, err := stockFundChanges(context.Background(), idx, reader, "BHP", "2026-08-03", "2026-10-31")
	require.NoError(t, err)
	var sum float64
	var priced int
	for _, c := range changes {
		if c.hasChangeValueAUD {
			sum += c.changeValueAUD
			priced++
		}
	}
	require.Equal(t, 2, priced, "both funds' shares compare, each at its own later file's price")
	assert.True(t, changes["statesuper|SFW"].hasChangeValueAUD)
	assert.InDelta(t, 4e8, changes["statesuper|SFW"].changeValueAUD, 1, "ten million shares at SFW's own end price of 40")
	assert.InDelta(t, 4e8, changes["vanguard|VAS"].changeValueAUD, 1)
	assert.InDelta(t, 8e8, sum, 1, "the two lines")

	figs, err := computeIndexFunds(context.Background(), idx, reader, "2026-08-03", "2026-10-31")
	require.NoError(t, err)
	require.NotNil(t, figs.stocks["BHP"])
	assert.True(t, figs.stocks["BHP"].hasFlow)
	assert.InDelta(t, figs.stocks["BHP"].flow, sum, 1e-6, "the per-fund lines sum to the map's flow")
}

// A fund whose end file states shares with no value has no price of its own at the
// end, so its change is unvalued (its units change still reads), and the map's flow
// is the other fund's change alone.
func TestStockFundChangeUnpricedEndLeavesTheFundOutOfTheFlow(t *testing.T) {
	snaps := append(fundFlowSnapshots(),
		shortsstore.FundSnapshotRow{ID: 6, InstitutionSlug: "statesuper", FundName: "SFW", FundCode: "SFW", SourceKind: "etf", AsAt: "2026-08-31"},
		shortsstore.FundSnapshotRow{ID: 7, InstitutionSlug: "statesuper", FundName: "SFW", FundCode: "SFW", SourceKind: "etf", AsAt: "2026-10-31"},
	)
	holdings := fundFlowHoldings()
	holdings[6] = []shortsstore.FundSnapshotHoldingRow{{SnapshotID: 6, StockCode: "BHP", Units: new(50e6), Value: new(2e9)}}
	holdings[7] = []shortsstore.FundSnapshotHoldingRow{{SnapshotID: 7, StockCode: "BHP", Units: new(60e6)}}
	idx := newFundIndex(snaps)
	reader := &fakeFundFlowReader{holdings: holdings}

	changes, err := stockFundChanges(context.Background(), idx, reader, "BHP", "2026-08-03", "2026-10-31")
	require.NoError(t, err)
	sfw := changes["statesuper|SFW"]
	assert.True(t, sfw.hasUnitsChange)
	assert.InDelta(t, 1e7, sfw.unitsChange, 1)
	assert.False(t, sfw.hasChangeValueAUD, "no price of its own at the end: its change is unvalued")

	figs, err := computeIndexFunds(context.Background(), idx, reader, "2026-08-03", "2026-10-31")
	require.NoError(t, err)
	assert.InDelta(t, changes["vanguard|VAS"].changeValueAUD, figs.stocks["BHP"].flow, 1e-6, "the map's flow is VAS's change alone")
}

// Two funds in one window, one with a value alone at the end and the other with
// units on both sides: the flow is the second fund's change alone, and the start
// shares the first fund held are not counted in the fund_change_pct denominator.
func TestComputeIndexFundsLeavesOutAValueOnlyFundPerPair(t *testing.T) {
	snaps := append(fundFlowSnapshots(),
		shortsstore.FundSnapshotRow{ID: 6, InstitutionSlug: "statesuper", FundName: "SFW", FundCode: "SFW", SourceKind: "etf", AsAt: "2026-08-31"},
		shortsstore.FundSnapshotRow{ID: 7, InstitutionSlug: "statesuper", FundName: "SFW", FundCode: "SFW", SourceKind: "etf", AsAt: "2026-10-31"},
	)
	holdings := fundFlowHoldings()
	holdings[6] = []shortsstore.FundSnapshotHoldingRow{{SnapshotID: 6, StockCode: "BHP", Units: new(100e6), Value: new(4e9)}}
	holdings[7] = []shortsstore.FundSnapshotHoldingRow{{SnapshotID: 7, StockCode: "BHP", Value: new(3.9e9)}}
	idx := newFundIndex(snaps)
	figs, err := computeIndexFunds(context.Background(), idx, &fakeFundFlowReader{holdings: holdings}, "2026-08-03", "2026-10-31")
	require.NoError(t, err)

	bhp := figs.stocks["BHP"]
	require.NotNil(t, bhp)
	assert.True(t, bhp.hasFlow)
	assert.InDelta(t, 4e8, bhp.flow, 1, "VAS's ten million shares at 40, and SFW's 100M start left out with its end")
	assert.InDelta(t, 4e9, bhp.startAtEnd, 1, "only VAS's 100M starting shares")
}
