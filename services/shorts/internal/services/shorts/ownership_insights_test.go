package shorts

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// insightsFixtureSnapshots: Vanguard's VAS has three monthly files, so a window
// compares it; BlackRock's IOZ has one file, so no window compares it; a
// Hostplus super option has one semi-annual file.
func insightsFixtureSnapshots() []shortsstore.FundSnapshotRow {
	return []shortsstore.FundSnapshotRow{
		{ID: 1, InstitutionSlug: "vanguard", FundName: "VAS", FundCode: "VAS", SourceKind: "etf", AsAt: "2026-08-31"},
		{ID: 2, InstitutionSlug: "vanguard", FundName: "VAS", FundCode: "VAS", SourceKind: "etf", AsAt: "2026-09-30"},
		{ID: 3, InstitutionSlug: "vanguard", FundName: "VAS", FundCode: "VAS", SourceKind: "etf", AsAt: "2026-10-31"},
		{ID: 4, InstitutionSlug: "blackrock", FundName: "IOZ", FundCode: "IOZ", SourceKind: "etf", AsAt: "2026-10-15"},
		{ID: 5, InstitutionSlug: "hostplus", FundName: "Balanced", SourceKind: "super_phd", AsAt: "2026-06-30"},
	}
}

// insightsFixtureHoldings: VAS grows BHP from 100M to 110M shares at a falling
// price, exits PLS and buys CBA.
func insightsFixtureHoldings() map[int64][]shortsstore.FundSnapshotHoldingRow {
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

func insightsFixtureNotices() []shortsstore.SubstantialNoticeRow {
	n := func(code, holder, slug, kind, form, event string, prev, present *float64, ceased bool) shortsstore.SubstantialNoticeRow {
		return shortsstore.SubstantialNoticeRow{StockCode: code, HolderKey: holder, HolderName: holder, InstitutionSlug: slug, Kind: kind,
			Form: form, EventDate: event, AnnouncedOn: event, AnnouncementURL: "https://asx/" + code + holder + event,
			PreviousPct: prev, PresentPct: present, Ceased: ceased}
	}
	return []shortsstore.SubstantialNoticeRow{
		n("MIN", "name:chris ellison", "", "unclassified", "605", "2026-10-25", new(7.0), new(4.0), true),
		n("CBA", "name:new holder", "", "unclassified", "603", "2026-10-20", nil, new(5.2), false),
		n("PLS", "regal-partners", "regal-partners", "hedge_fund", "604", "2026-10-02", new(5.0), new(6.0), false),
		n("BHP", "vanguard", "vanguard", "index_manager", "604", "2026-09-29", new(6.0), new(5.1), false),
		n("PLS", "perpetual", "perpetual", "active_manager", "603", "2025-01-15", nil, new(5.5), false),
	}
}

// fakeInsightsReader computes what the Postgres reads compute, from the
// fixture's files, and records the pairs it was asked for.
type fakeInsightsReader struct {
	holdings map[int64][]shortsstore.FundSnapshotHoldingRow
	pairs    [][]shortsstore.FundSnapshotPair
}

func (f *fakeInsightsReader) FundSnapshotHoldings(_ context.Context, ids []int64, code string) ([]shortsstore.FundSnapshotHoldingRow, error) {
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

func (f *fakeInsightsReader) FundHoldingChanges(_ context.Context, pairs []shortsstore.FundSnapshotPair, codes []string) ([]shortsstore.FundHoldingChangeRow, error) {
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
		value := 0.0
		if r.Value != nil {
			value = *r.Value
		}
		switch {
		case r.Units != nil && later:
			c.UnitsTo += *r.Units
			c.UnitValueTo += value
			c.HasUnitsTo = true
		case r.Units != nil:
			c.UnitsFrom += *r.Units
			c.UnitValueFrom += value
			c.HasUnitsFrom = true
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

func insightsTestUniverse() *ownershipUniverse {
	return newOwnershipUniverse(ownershipFixture(), ownershipFixtureCounts(), ownershipFixtureAttempts(), ownershipTestNow)
}

func buildInsightsForTest(t *testing.T, q insightsQuery, snaps []shortsstore.FundSnapshotRow) (*shortsv1alpha1.GetOwnershipInsightsResponse, *fakeInsightsReader) {
	t.Helper()
	b := newInsightsBase(snaps, insightsFixtureNotices())
	from, to, err := b.resolveWindow(q.from, q.to)
	require.NoError(t, err)
	q.from, q.to = from, to
	reader := &fakeInsightsReader{holdings: insightsFixtureHoldings()}
	resp, err := buildOwnershipInsights(context.Background(), insightsTestUniverse(), b, reader, q)
	require.NoError(t, err)
	return resp, reader
}

func sectorNamed(resp *shortsv1alpha1.GetOwnershipInsightsResponse, name string) *shortsv1alpha1.InsightSector {
	for _, s := range resp.Sectors {
		if s.Sector == name {
			return s
		}
	}
	return nil
}

func stockCoded(resp *shortsv1alpha1.GetOwnershipInsightsResponse, code string) *shortsv1alpha1.InsightStock {
	for _, s := range resp.Stocks {
		if s.StockCode == code {
			return s
		}
	}
	return nil
}

func TestInsightBucketsSplitWeeksMondayToSundayAndLongWindowsByMonth(t *testing.T) {
	kind, buckets := insightBuckets("2026-10-01", "2026-10-31")
	assert.Equal(t, "week", kind)
	require.Len(t, buckets, 5)
	assert.Equal(t, "2026-10-01", buckets[0].Start, "the first week is clipped to the window")
	assert.Equal(t, "2026-10-04", buckets[0].End, "2026-10-04 is a Sunday")
	assert.Equal(t, "2026-10-05", buckets[1].Start)
	assert.Equal(t, "2026-10-26", buckets[4].Start)
	assert.Equal(t, "2026-10-31", buckets[4].End, "the last week is clipped to the window")

	kind, buckets = insightBuckets("2026-01-15", "2026-10-31")
	assert.Equal(t, "month", kind)
	require.Len(t, buckets, 10)
	assert.Equal(t, "2026-01-15", buckets[0].Start)
	assert.Equal(t, "2026-01-31", buckets[0].End)
	assert.Equal(t, "2026-02-28", buckets[1].End)
	assert.Equal(t, "2026-10-31", buckets[9].End)

	kind, buckets = insightBuckets("2026-10-31", "2026-10-31")
	assert.Equal(t, "week", kind)
	require.Len(t, buckets, 1, "a one-day window is one bucket")

	kind, buckets = insightBuckets("", "")
	assert.Empty(t, kind)
	assert.Empty(t, buckets)
}

func TestResolveWindowDefaultsClampsAndRefuses(t *testing.T) {
	b := newInsightsBase(insightsFixtureSnapshots(), insightsFixtureNotices())
	assert.Equal(t, "2025-01-15", b.timelineFrom, "the oldest notice")
	assert.Equal(t, "2026-10-31", b.timelineTo, "the newest file")

	from, to, err := b.resolveWindow("", "")
	require.NoError(t, err)
	assert.Equal(t, "2026-08-03", from, "the default is the 90 days to the newest date")
	assert.Equal(t, "2026-10-31", to)

	from, to, err = b.resolveWindow("2020-01-01", "2030-01-01")
	require.NoError(t, err)
	assert.Equal(t, "2025-01-15", from, "clamped to the timeline")
	assert.Equal(t, "2026-10-31", to)

	from, to, err = b.resolveWindow("2026-09-01", "")
	require.NoError(t, err)
	assert.Equal(t, "2026-09-01", from)
	assert.Equal(t, "2026-10-31", to)

	_, _, err = b.resolveWindow("2026-10-02", "2026-10-01")
	assert.ErrorIs(t, err, errInsightsWindow)

	empty := newInsightsBase(nil, nil)
	from, to, err = empty.resolveWindow("2026-01-01", "2026-02-01")
	require.NoError(t, err)
	assert.Empty(t, from, "no timeline, no window")
	assert.Empty(t, to)
}

func TestInsightsFundStartsFromTheFileAtTheWindowOrTheFirstInside(t *testing.T) {
	b := newInsightsBase(insightsFixtureSnapshots(), nil)
	var vas *insightsFund
	for _, f := range b.funds {
		if f.name == "VAS" {
			vas = f
		}
	}
	require.NotNil(t, vas)
	assert.Nil(t, vas.at("2026-08-30"))
	assert.Equal(t, int64(1), vas.at("2026-08-31").ID)
	assert.Equal(t, int64(2), vas.at("2026-10-30").ID)
	assert.Equal(t, int64(2), vas.startIn("2026-10-01", "2026-10-31").ID, "the newest file on or before the start")
	assert.Equal(t, int64(1), vas.startIn("2026-08-03", "2026-10-31").ID, "else the first file inside the window")
	assert.Nil(t, vas.startIn("2026-01-01", "2026-02-01"), "no file at or inside the window")
	assert.Equal(t, []string{"2026-06-30", "2026-08-31", "2026-09-30", "2026-10-15", "2026-10-31"}, b.snapshotDates)
}

func TestOwnershipInsightsComparesEachFundWithItself(t *testing.T) {
	resp, _ := buildInsightsForTest(t, insightsQuery{}, insightsFixtureSnapshots())
	w := resp.Window
	assert.Equal(t, "2026-08-03", w.From)
	assert.Equal(t, "2026-10-31", w.To)
	assert.Equal(t, "week", w.Bucket)
	assert.EqualValues(t, 1, w.FundsCompared, "IOZ's one file inside the window is never new money")
	assert.EqualValues(t, 3, w.FundsAtEnd)
	assert.Equal(t, "2026-08-31", w.StartFilesFrom)
	assert.Equal(t, "2026-10-15", w.EndFilesFrom)
	assert.Equal(t, "2026-10-31", w.EndFilesTo)
	assert.EqualValues(t, 4, w.NoticesInWindow, "the 2025 notice is outside the window")

	bhp := stockCoded(resp, "BHP")
	require.NotNil(t, bhp)
	assert.Equal(t, "Materials", bhp.Sector)
	assert.InDelta(t, 4.4e9+7.2e8, bhp.FundValueAud, 1, "every index fund's end file, compared or not")
	assert.EqualValues(t, 2, bhp.Funds)
	assert.True(t, bhp.HasFundChange)
	assert.InDelta(t, 10, bhp.FundChangePct, 1e-9, "shares compared, not value: 100M to 110M")
	assert.InDelta(t, 10e6*40, bhp.FundFlowAud, 1, "the change in shares at the end file's price")
	assert.True(t, bhp.HasIndexPct)
	assert.InDelta(t, 128e6/5.07e9*100, bhp.IndexPct, 1e-4)
	assert.InDelta(t, 11.4, bhp.DisclosedPct, 1e-9)
	assert.InDelta(t, 0.114*3e11, bhp.DisclosedValueAud, 1)

	pls := stockCoded(resp, "PLS")
	require.NotNil(t, pls)
	assert.False(t, pls.HasFundValue, "no index fund holds it at the end")
	assert.InDelta(t, -100, pls.FundChangePct, 1e-9)
	assert.InDelta(t, -50e6*2, pls.FundFlowAud, 1, "a position gone is valued at its last price")
	assert.InDelta(t, 1.0, pls.NoticeNetPp, 1e-9)
	assert.EqualValues(t, 1, pls.Notices)

	cba := stockCoded(resp, "CBA")
	require.NotNil(t, cba)
	assert.True(t, cba.HasFundFlow)
	assert.False(t, cba.HasFundChange, "a new position has no percentage change")
	assert.InDelta(t, 3e8, cba.FundFlowAud, 1)

	mat := sectorNamed(resp, "Materials")
	require.NotNil(t, mat)
	assert.InDelta(t, 4e8-1e8, mat.FundFlowAud, 1)
	assert.InDelta(t, 3e8/(100e6*40+50e6*2)*100, mat.FundChangePct, 1e-3)
	assert.InDelta(t, 2e8+1.5e9, mat.SuperValueAud, 1)
	assert.InDelta(t, 0.1, mat.NoticeNetPp, 1e-9, "+1.0 at PLS and -0.9 at BHP")
	assert.EqualValues(t, 1, mat.Rises)
	assert.EqualValues(t, 1, mat.Falls)
	assert.Equal(t, "Materials", resp.Sectors[0].Sector, "sectors rank by index fund value")
	assert.EqualValues(t, 4, mat.Interests, "BHP's two and PLS's two")
	assert.EqualValues(t, 3, mat.InvestorInterests, "Citigroup, a bank, is not counted as crowded")

	other := sectorNamed(resp, "")
	require.NotNil(t, other, "MIN has no industry: the sector is empty and the web prints Other")
	assert.EqualValues(t, 1, other.Ceased)
	assert.InDelta(t, -3, other.NoticeNetPp, 1e-9)

	banks := sectorNamed(resp, "Banks")
	require.NotNil(t, banks)
	assert.EqualValues(t, 1, banks.Became)
	assert.Zero(t, banks.NoticeNetPp, "a 603 that states no previous figure moves no points")
}

func TestOwnershipInsightsHeatmapPlacesChangesInTheirBuckets(t *testing.T) {
	resp, reader := buildInsightsForTest(t, insightsQuery{}, insightsFixtureSnapshots())
	hm := resp.Heatmap
	require.Len(t, hm.Buckets, 13)
	idx := func(date string) int {
		for i, b := range hm.Buckets {
			if b.Start <= date && date <= b.End {
				return i
			}
		}
		return -1
	}
	var mat *shortsv1alpha1.InsightHeatRow
	for _, r := range hm.Rows {
		require.Len(t, r.Cells, len(hm.Buckets))
		if r.Sector == "Materials" {
			mat = r
		}
	}
	require.NotNil(t, mat)
	sep := mat.Cells[idx("2026-09-30")]
	assert.True(t, sep.HasFundFlow)
	assert.EqualValues(t, 1, sep.FundsCompared)
	assert.InDelta(t, 5e6*(4.6e9/105e6)-10e6*2.25, sep.FundFlowAud, 1, "VAS's August to September files")
	assert.True(t, sep.HasFundFlow)
	assert.EqualValues(t, 2, sep.Notices, "BHP's 604 of 2026-09-29 and PLS's of 2026-10-02 share a week")
	assert.InDelta(t, 0.1, sep.NoticeNetPp, 1e-9)
	assert.EqualValues(t, 1, sep.Rises)
	assert.EqualValues(t, 1, sep.Falls)
	oct := mat.Cells[idx("2026-10-31")]
	assert.True(t, oct.HasFundFlow, "VAS's September to October files")
	quiet := mat.Cells[idx("2026-08-10")]
	assert.False(t, quiet.HasFundFlow, "no fund filed a newer file that week: n/a, not zero")
	assert.Zero(t, quiet.Notices)

	// One read for the window and every bucket.
	require.Len(t, reader.pairs, 1)
	groups := map[int32]int{}
	for _, p := range reader.pairs[0] {
		groups[p.Group]++
		assert.NotEqual(t, p.From, p.To)
	}
	assert.Equal(t, 1, groups[windowGroup])
	assert.Len(t, groups, 3, "the window and two buckets with a newer file")
}

func TestOwnershipInsightsMovesAndFocus(t *testing.T) {
	resp, _ := buildInsightsForTest(t, insightsQuery{}, insightsFixtureSnapshots())
	require.Len(t, resp.Moves, 3, "the 603 without a previous figure states no move")
	assert.Equal(t, "MIN", resp.Moves[0].StockCode, "the largest move first, whichever way")
	assert.Equal(t, "PLS", resp.Moves[1].StockCode)
	assert.Equal(t, "decreased", resp.Moves[2].Event)

	focused, reader := buildInsightsForTest(t, insightsQuery{sector: "Materials", stockCode: "BHP"}, insightsFixtureSnapshots())
	for _, s := range focused.Stocks {
		assert.Equal(t, "Materials", s.Sector, "a focused sector lists its own stocks only")
	}
	for _, m := range focused.Moves {
		assert.Contains(t, []string{"BHP", "PLS"}, m.StockCode)
	}
	require.NotEmpty(t, focused.SectorInstitutions)
	assert.Equal(t, "vanguard", focused.SectorInstitutions[0].InstitutionSlug)
	assert.True(t, focused.SectorInstitutions[0].HasFlow)
	assert.InDelta(t, 3e8, focused.SectorInstitutions[0].FlowAud, 1)
	require.Len(t, reader.pairs, 2, "the sector's institutions are one more read")

	d := focused.StockDetail
	require.NotNil(t, d)
	assert.Equal(t, "BHP Group", d.CompanyName)
	assert.EqualValues(t, 2, d.Holders)
	require.Len(t, d.Funds, 3)
	assert.Equal(t, "vanguard", d.Funds[0].InstitutionSlug, "by value")
	assert.Equal(t, "2026-08-31", d.Funds[0].StartAsAt)
	assert.True(t, d.Funds[0].HasStartUnits)
	assert.InDelta(t, 100e6, d.Funds[0].StartUnits, 1)
	var ioz, super *shortsv1alpha1.InsightFundPosition
	for _, f := range d.Funds {
		switch f.FundName {
		case "IOZ":
			ioz = f
		case "Balanced":
			super = f
		}
	}
	require.NotNil(t, ioz)
	assert.Empty(t, ioz.StartAsAt, "a fund the window does not compare has no start")
	require.NotNil(t, super)
	assert.Equal(t, "super_phd", super.SourceKind)
	require.Len(t, d.Notices, 1)

	unknown, _ := buildInsightsForTest(t, insightsQuery{stockCode: "ZZZ"}, insightsFixtureSnapshots())
	assert.Nil(t, unknown.StockDetail, "a code nothing names has no detail")
}

func TestOwnershipInsightsWithOneFilePerFundReadsNoticesOnly(t *testing.T) {
	snaps := []shortsstore.FundSnapshotRow{insightsFixtureSnapshots()[2], insightsFixtureSnapshots()[3]}
	resp, _ := buildInsightsForTest(t, insightsQuery{}, snaps)
	assert.Zero(t, resp.Window.FundsCompared)
	assert.Empty(t, resp.Window.StartFilesFrom)
	for _, s := range resp.Stocks {
		assert.False(t, s.HasFundChange, "%s: one file is a level, never a change", s.StockCode)
		assert.False(t, s.HasFundFlow)
	}
	for _, s := range resp.Sectors {
		assert.False(t, s.HasFundFlow)
	}
	for _, r := range resp.Heatmap.Rows {
		for _, c := range r.Cells {
			assert.False(t, c.HasFundFlow)
		}
	}
	assert.True(t, stockCoded(resp, "BHP").HasFundValue, "the level is still drawn")
	assert.EqualValues(t, 4, resp.Window.NoticesInWindow, "the notices still move")
	assert.NotEmpty(t, resp.Moves)
}

func TestBuildInsightFlowFoldsTheTailIntoOther(t *testing.T) {
	var edges []flowEdge
	for i := range 12 {
		edges = append(edges, flowEdge{kind: "index_manager", holder: fmt.Sprintf("inst:h%02d", i), label: fmt.Sprintf("H%02d", i),
			sector: fmt.Sprintf("S%02d", i), value: float64(100 - i)})
	}
	edges = append(edges, flowEdge{kind: "super_fund", holder: "inst:h00", label: "H00", sector: "S00", value: 50})
	flow := buildInsightFlow(edges)
	total := 0.0
	columns := map[int32]float64{}
	labels := map[string]bool{}
	for _, n := range flow.Nodes {
		columns[n.Column] += n.ValueAud
		labels[n.Label] = true
	}
	for _, e := range edges {
		total += e.value
	}
	assert.InDelta(t, total, flow.TotalAud, 1e-9)
	for c, v := range columns {
		assert.InDelta(t, total, v, 1e-9, "column %d carries the whole flow", c)
	}
	assert.True(t, labels["Other"], "holders past the tenth fold into Other")
	assert.True(t, labels["Other sectors"])
	assert.False(t, labels["H11"])
	assert.True(t, labels["H00"])
	for _, l := range flow.Links {
		assert.Less(t, flow.Nodes[l.Source].Column, flow.Nodes[l.Target].Column, "links run left to right")
	}
	assert.Empty(t, buildInsightFlow(nil).Nodes)
}

func TestInsightSectorPrintsPlaceholdersAsNone(t *testing.T) {
	assert.Equal(t, "", insightSector("Not Applic"))
	assert.Equal(t, "", insightSector(" class pend "))
	assert.Equal(t, "", insightSector("Other"))
	assert.Equal(t, "Not Applic Holdings", insightSector("Not Applic Holdings"))
	assert.Equal(t, "Materials", insightSector(" Materials "))
}

// fakeInsightsStore is the ownership fake with the insights reads beside it, so
// the handler finds it by type assertion as it finds the Postgres store.
type fakeInsightsStore struct {
	*fakeOwnershipStore
	*fakeInsightsReader
	snaps []shortsstore.FundSnapshotRow
}

func (f *fakeInsightsStore) FundSnapshots(context.Context) ([]shortsstore.FundSnapshotRow, error) {
	f.read("FundSnapshots")
	return f.snaps, nil
}

func TestGetOwnershipInsightsHandler(t *testing.T) {
	ctx := context.Background()
	ask := func(s *ShortsServer, msg *shortsv1alpha1.GetOwnershipInsightsRequest) (*shortsv1alpha1.GetOwnershipInsightsResponse, error) {
		resp, err := s.GetOwnershipInsights(ctx, connect.NewRequest(msg))
		if err != nil {
			return nil, err
		}
		return resp.Msg, nil
	}

	t.Run("a server without an ownership store answers empty", func(t *testing.T) {
		resp, err := ask(&ShortsServer{}, &shortsv1alpha1.GetOwnershipInsightsRequest{})
		require.NoError(t, err)
		assert.Empty(t, resp.Sectors)
		require.NotNil(t, resp.Window)
	})

	t.Run("refuses arguments that are not a window", func(t *testing.T) {
		for _, msg := range []*shortsv1alpha1.GetOwnershipInsightsRequest{
			{WindowFrom: "2026-13-01"},
			{WindowTo: "yesterday"},
			{WindowFrom: "2026-10-02", WindowTo: "2026-10-01"},
			{StockCode: "BHP;DROP"},
			{Sector: strings.Repeat("x", insightsSectorMaxLen+1)},
		} {
			_, err := ask(&ShortsServer{}, msg)
			require.Error(t, err, "%v", msg)
			assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
		}
	})

	t.Run("a database without 000137 reads empty, never an error", func(t *testing.T) {
		empty := newFakeOwnershipStore(&ownershipData{stats: &shortsstore.NoticeStats{PerHolder: map[string]shortsstore.HolderNoticeStats{}}})
		store := &fakeInsightsStore{fakeOwnershipStore: empty, fakeInsightsReader: &fakeInsightsReader{}}
		s := newOwnershipTestServer(empty, &fakeClock{t: ownershipTestNow})
		s.ownershipStore = store
		resp, err := ask(s, &shortsv1alpha1.GetOwnershipInsightsRequest{WindowFrom: "2026-01-01", StockCode: "BHP"})
		require.NoError(t, err)
		assert.Empty(t, resp.Window.From)
		assert.Empty(t, resp.Sectors)
		assert.Empty(t, resp.Heatmap.Buckets)
		assert.Nil(t, resp.StockDetail)
	})

	t.Run("serves the fixture and holds one base per generation", func(t *testing.T) {
		base := newFakeOwnershipStore(ownershipFixture())
		base.notices = insightsFixtureNotices()
		store := &fakeInsightsStore{fakeOwnershipStore: base,
			fakeInsightsReader: &fakeInsightsReader{holdings: insightsFixtureHoldings()}, snaps: insightsFixtureSnapshots()}
		s := newOwnershipTestServer(base, &fakeClock{t: ownershipTestNow})
		s.ownershipStore = store
		s.ownershipInsights = &ownershipInsightsHolder{}

		first, err := ask(s, &shortsv1alpha1.GetOwnershipInsightsRequest{})
		require.NoError(t, err)
		assert.Equal(t, "2026-08-03", first.Window.From)
		require.NotNil(t, stockCoded(first, "BHP"))
		again, err := ask(s, &shortsv1alpha1.GetOwnershipInsightsRequest{WindowFrom: "2026-08-03", WindowTo: "2026-10-31"})
		require.NoError(t, err)
		assert.Same(t, first, again, "the default and its explicit twin are one cached answer")
		_, err = ask(s, &shortsv1alpha1.GetOwnershipInsightsRequest{WindowFrom: "2026-10-01"})
		require.NoError(t, err)
		assert.Equal(t, 1, base.readCount("FundSnapshots"), "one base per generation")
		assert.Len(t, store.pairs, 2, "two windows, one change read each")
	})
}

func TestInsightsWindowCacheIsBounded(t *testing.T) {
	h := &ownershipInsightsHolder{}
	for i := range insightsWindowCacheSize + 10 {
		_, err := h.getWindow(7, fmt.Sprintf("k%d", i), func() (*shortsv1alpha1.GetOwnershipInsightsResponse, error) {
			return &shortsv1alpha1.GetOwnershipInsightsResponse{}, nil
		})
		require.NoError(t, err)
	}
	assert.Len(t, h.windows, insightsWindowCacheSize)
	assert.NotContains(t, h.windows, "k0", "the oldest answer is dropped first")
	_, err := h.getWindow(8, "k1", func() (*shortsv1alpha1.GetOwnershipInsightsResponse, error) {
		return &shortsv1alpha1.GetOwnershipInsightsResponse{}, nil
	})
	require.NoError(t, err)
	assert.Len(t, h.windows, 1, "a new generation drops every older answer")
}
