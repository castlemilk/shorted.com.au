package shorts

import (
	"context"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"

	"connectrpc.com/connect"
	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// deskStore is the fixture register served through the desk's reads too. The
// window's totals and changes are computed the way the store computes them (the
// notice's Delta, the holder's kind, the company's market cap), so a handler test
// sees the rule the SQL applies; the store's own tests pin the SQL to it.
type deskStore struct {
	*fakeOwnershipStore
	notices   []shortsstore.SubstantialNoticeRow
	weekly    []shortsstore.IndustryWeekRow
	snapshots []string
	pairs     []shortsstore.FundPositionPair
	series    []shortsstore.FundSeriesRow
	// weeklyKinds is the kind each NoticeWeeklyByIndustry call was given, in order.
	weeklyKinds []string
}

func (f *deskStore) inWindow(from, until string) []shortsstore.SubstantialNoticeRow {
	var out []shortsstore.SubstantialNoticeRow
	for _, n := range f.notices {
		if n.AnnouncedOn >= from && n.AnnouncedOn <= until {
			out = append(out, n)
		}
	}
	return out
}

func (f *deskStore) NoticeFlowByStock(_ context.Context, from, until string) (map[string]shortsstore.NoticeFlow, error) {
	f.read("NoticeFlowByStock")
	out := map[string]shortsstore.NoticeFlow{}
	for _, n := range f.inWindow(from, until) {
		flow := out[n.StockCode]
		flow.Notices++
		if d, ok := noticeDelta(n); ok {
			flow.Net += d
			flow.Has = true
		}
		out[n.StockCode] = flow
	}
	return out, nil
}

func (f *deskStore) NoticeChangesByKindIndustry(_ context.Context, from, until string) ([]shortsstore.NoticeChangeRow, error) {
	f.read("NoticeChangesByKindIndustry")
	type key struct {
		kind, industry string
		up             bool
	}
	rows := map[key]*shortsstore.NoticeChangeRow{}
	for _, n := range f.inWindow(from, until) {
		d, ok := noticeDelta(n)
		if !ok || d == 0 {
			continue
		}
		c := f.d.companies[n.StockCode]
		k := key{n.Kind, c.Industry, d > 0}
		r := rows[k]
		if r == nil {
			r = &shortsstore.NoticeChangeRow{Kind: n.Kind, Industry: c.Industry, Up: d > 0}
			rows[k] = r
		}
		r.Notices++
		if c.MarketCap != nil {
			r.ExposureAUD += d / 100 * *c.MarketCap
			r.HasExposure = true
		}
	}
	var out []shortsstore.NoticeChangeRow
	for _, r := range rows {
		out = append(out, *r)
	}
	return out, nil
}

func (f *deskStore) NoticeWeeklyByIndustry(_ context.Context, _, _, kind string) ([]shortsstore.IndustryWeekRow, error) {
	f.read("NoticeWeeklyByIndustry")
	f.weeklyKinds = append(f.weeklyKinds, kind)
	return f.weekly, nil
}

// NoticeLargestMoves mirrors the store's query: the window's notices that state
// both figures and a difference, neither ceased nor Form 605, ranked by the size
// of the change, the newer release, the stock code and the URL, at most limit.
func (f *deskStore) NoticeLargestMoves(_ context.Context, from, until, kind string, limit int) ([]shortsstore.SubstantialNoticeRow, error) {
	f.read("NoticeLargestMoves")
	var out []shortsstore.SubstantialNoticeRow
	for _, n := range f.inWindow(from, until) {
		if kind != "" && n.Kind != kind {
			continue
		}
		if n.Ceased || n.Form == "605" || n.PresentPct == nil || n.PreviousPct == nil || *n.PresentPct == *n.PreviousPct {
			continue
		}
		out = append(out, n)
	}
	mag := func(n shortsstore.SubstantialNoticeRow) float64 {
		return math.Abs(*n.PresentPct - *n.PreviousPct)
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if mag(a) != mag(b) {
			return mag(a) > mag(b)
		}
		if a.AnnouncedOn != b.AnnouncedOn {
			return a.AnnouncedOn > b.AnnouncedOn
		}
		if a.StockCode != b.StockCode {
			return a.StockCode < b.StockCode
		}
		return a.AnnouncementURL > b.AnnouncementURL
	})
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (f *deskStore) FundSnapshotDates(context.Context) ([]string, error) {
	f.read("FundSnapshotDates")
	return f.snapshots, nil
}

func (f *deskStore) FundPositionPairs(context.Context, string, string) ([]shortsstore.FundPositionPair, error) {
	f.read("FundPositionPairs")
	return f.pairs, nil
}

func (f *deskStore) StockFundSeries(context.Context, string) ([]shortsstore.FundSeriesRow, error) {
	f.read("StockFundSeries")
	return f.series, nil
}

// noticeDelta is the change in voting power a notice states, in percentage points,
// as noticeDeltaSQL decides it. ok is false when the notice states no change. A
// ceased notice counts its previous figure as a fall; a notice with no previous
// figure counts its present figure as a rise (a 603); otherwise the difference.
func noticeDelta(r shortsstore.SubstantialNoticeRow) (float64, bool) {
	switch {
	case r.Ceased || r.Form == "605":
		if r.PreviousPct == nil {
			return 0, false
		}
		return -*r.PreviousPct, true
	case r.PreviousPct == nil:
		if r.PresentPct == nil {
			return 0, false
		}
		return *r.PresentPct, true
	case r.PresentPct == nil:
		return 0, false
	}
	return *r.PresentPct - *r.PreviousPct, true
}

// deskServer serves the desk store through the real handlers, on the fake clock.
func deskServer(store *deskStore) (*ShortsServer, *fakeClock) {
	clock := &fakeClock{t: ownershipTestNow}
	s := newOwnershipTestServer(store.fakeOwnershipStore, clock)
	s.ownershipStore = store
	return s, clock
}

func deskTestStore(notices []shortsstore.SubstantialNoticeRow) *deskStore {
	return &deskStore{fakeOwnershipStore: newFakeOwnershipStore(ownershipFixture()), notices: notices}
}

// deskNotices are three in the default window and one before it.
func deskNotices() []shortsstore.SubstantialNoticeRow {
	return []shortsstore.SubstantialNoticeRow{
		{StockCode: "BHP", HolderKey: "citigroup", Kind: "bank_broker", Form: "604", PresentPct: new(6.3), PreviousPct: new(5.0),
			AnnouncedOn: "2026-10-02", AnnouncementURL: "a1"},
		{StockCode: "BHP", HolderKey: "vanguard", Kind: "index_manager", Form: "605", Ceased: true, PreviousPct: new(4.0),
			AnnouncedOn: "2026-10-05", AnnouncementURL: "a2"},
		{StockCode: "PLS", HolderKey: "regal-partners", Kind: "hedge_fund", Form: "603", PresentPct: new(6.0),
			AnnouncedOn: "2026-10-03", AnnouncementURL: "a3"},
		{StockCode: "BHP", HolderKey: "vanguard", Kind: "index_manager", Form: "604", PresentPct: new(4.0), PreviousPct: new(4.5),
			AnnouncedOn: "2026-06-01", AnnouncementURL: "a0"},
	}
}

// deskFixture is the desk section of the clamps fixture the web mirrors.
type deskFixture struct {
	WindowChips       []int    `json:"windowChips"`
	DefaultWindowDays int      `json:"defaultWindowDays"`
	MaxSpanDays       int      `json:"maxSpanDays"`
	Lenses            []string `json:"lenses"`
	Newest            string   `json:"newest"`
	Windows           []struct {
		From         string `json:"from"`
		To           string `json:"to"`
		ResolvedFrom string `json:"resolvedFrom"`
		ResolvedTo   string `json:"resolvedTo"`
		Rejected     bool   `json:"rejected"`
	} `json:"windows"`
	// NoticeDates are the feed's date rule: named dates are the window, resolved
	// into the span the store reads. An empty resolvedUntil is no upper bound.
	NoticeDates []struct {
		WindowDays    int32  `json:"windowDays"`
		Since         string `json:"since"`
		Until         string `json:"until"`
		ResolvedSince string `json:"resolvedSince"`
		ResolvedUntil string `json:"resolvedUntil"`
		Window        int32  `json:"window"`
		Rejected      bool   `json:"rejected"`
	} `json:"noticeDates"`
	ActivityWeeks []struct {
		In       int32 `json:"in"`
		Out      int   `json:"out"`
		Rejected bool  `json:"rejected"`
	} `json:"activityWeeks"`
	FundLimit []struct {
		In       int32 `json:"in"`
		Out      int   `json:"out"`
		Rejected bool  `json:"rejected"`
	} `json:"fundLimit"`
}

func readDeskFixture(t *testing.T) deskFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "..", "web", "src", "@", "lib", "ownership", "__fixtures__", "clamps.json"))
	require.NoError(t, err)
	var fx struct {
		Desk deskFixture `json:"desk"`
	}
	require.NoError(t, json.Unmarshal(raw, &fx))
	return fx.Desk
}

// TestDeskClampsFixtureMatchesTheHandlers holds the desk's date rules, weeks and
// fund limits to the fixture the web reads too.
func TestDeskClampsFixtureMatchesTheHandlers(t *testing.T) {
	fx := readDeskFixture(t)
	assert.Equal(t, deskWindowDays, fx.DefaultWindowDays)
	assert.Equal(t, deskMaxSpanDays, fx.MaxSpanDays)
	assert.Contains(t, fx.WindowChips, fx.DefaultWindowDays, "the default window is one of the chips")
	assert.Equal(t, []int{28, 91, 182, 364}, fx.WindowChips)
	assert.NotEmpty(t, fx.Lenses)
	today := ownershipTestNow
	for _, c := range fx.Windows {
		from, to, err := deskWindow(c.From, c.To, fx.Newest, today)
		if c.Rejected {
			assert.Error(t, err, "window %q to %q is refused", c.From, c.To)
			continue
		}
		require.NoError(t, err, "window %q to %q", c.From, c.To)
		assert.Equal(t, c.ResolvedFrom, from, "from for %q to %q", c.From, c.To)
		assert.Equal(t, c.ResolvedTo, to, "to for %q to %q", c.From, c.To)
	}
	for _, c := range fx.NoticeDates {
		q, err := parseNoticeFeedQuery(&shortsv1alpha1.ListSubstantialNoticesRequest{
			WindowDays: c.WindowDays, Since: c.Since, Until: c.Until})
		if err == nil {
			q, err = q.withSpan(utcDay(today))
		}
		if c.Rejected {
			assert.Error(t, err, "dates %q to %q (window %d) are refused", c.Since, c.Until, c.WindowDays)
			continue
		}
		require.NoError(t, err, "dates %q to %q (window %d)", c.Since, c.Until, c.WindowDays)
		f := q.filter(utcDay(today))
		assert.Equal(t, c.Window, q.window, "window for %q to %q", c.Since, c.Until)
		assert.Equal(t, c.ResolvedSince, f.Since, "since for %q to %q", c.Since, c.Until)
		assert.Equal(t, c.ResolvedUntil, f.Until, "until for %q to %q", c.Since, c.Until)
	}
	for _, c := range fx.ActivityWeeks {
		weeks, err := deskWeeksOf(c.In)
		if c.Rejected {
			assert.Error(t, err, "weeks %d is refused", c.In)
			continue
		}
		require.NoError(t, err)
		assert.Equal(t, c.Out, weeks, "weeks %d", c.In)
	}
	for _, c := range fx.FundLimit {
		limit, err := deskFundLimit(c.In)
		if c.Rejected {
			assert.Error(t, err, "limit %d is refused", c.In)
			continue
		}
		require.NoError(t, err)
		assert.Equal(t, c.Out, limit, "limit %d", c.In)
	}
}

func TestDeskWindowRefusesWhatItCannotMeasure(t *testing.T) {
	_, _, err := deskWindow("2026-10-02", "2026-10-01", "2026-10-16", ownershipTestNow)
	assert.ErrorContains(t, err, "must not be before")
	_, _, err = deskWindow("", "16-10-2026", "2026-10-16", ownershipTestNow)
	assert.ErrorContains(t, err, "YYYY-MM-DD")
	// With the register empty, the window ends today.
	from, to, err := deskWindow("", "", "", ownershipTestNow)
	require.NoError(t, err)
	assert.Equal(t, "2026-11-02", to)
	assert.Equal(t, "2026-08-04", from)
}

func TestBuildOwnershipMapCarriesTheWindow(t *testing.T) {
	u := ownershipFixtureUniverse()
	flows := map[string]shortsstore.NoticeFlow{
		"BHP": {Notices: 2, Net: -2.7, Has: true},
		"PLS": {Notices: 1, Net: 6, Has: true},
	}
	out := buildOwnershipMap(u, "2026-07-18", "2026-10-16", "2026-07-18", "2026-10-16", flows, indexFundFigures{})
	require.Len(t, out.Stocks, 4, "every stock with a current holder")
	byCode := map[string]*shortsv1alpha1.MapStock{}
	for _, m := range out.Stocks {
		byCode[m.StockCode] = m
	}
	bhp := byCode["BHP"]
	assert.InDelta(t, 11.4, bhp.DisclosedPct, 1e-9, "citigroup and vanguard, each counted")
	assert.InDelta(t, 5.1, bhp.InstitutionalPct, 1e-9, "banks and brokers are not an investor")
	assert.True(t, bhp.HasMarketCap)
	assert.True(t, bhp.HasIndexPct, "vanguard's units over BHP's shares on issue")
	assert.True(t, bhp.HasFlowPp)
	assert.InDelta(t, -2.7, bhp.FlowPp, 1e-9)
	assert.Equal(t, int32(2), bhp.Notices)
	pls := byCode["PLS"]
	assert.InDelta(t, 6, pls.HedgePct, 1e-9)
	assert.False(t, pls.HasMarketCap, "PLS states no market cap, so none is shown")
	minStock := byCode["MIN"]
	assert.False(t, minStock.HasFlowPp, "no notice in the window is no flow, not zero")
	assert.Equal(t, int32(0), minStock.Notices)
	assert.Equal(t, "WC8", out.Stocks[0].StockCode, "largest disclosure first")
	assert.Equal(t, "2026-10-16", out.AsOf)
}

func TestBuildOwnershipFlowsExposesAndDirects(t *testing.T) {
	u := ownershipFixtureUniverse()
	changes := []shortsstore.NoticeChangeRow{
		{Kind: "hedge_fund", Industry: "Materials", Up: false, ExposureAUD: -8e9, HasExposure: true, Notices: 1},
		{Kind: "hedge_fund", Industry: "Materials", Up: true, ExposureAUD: 1.5e8, HasExposure: true, Notices: 1},
	}
	out := buildOwnershipFlows(u, "2026-07-18", "2026-10-16", changes)
	var bank *shortsv1alpha1.FlowPosition
	for _, p := range out.Positions {
		if p.Kind == "bank_broker" {
			bank = p
		}
	}
	require.NotNil(t, bank)
	assert.True(t, bank.HasExposure)
	assert.InDelta(t, 6.3/100*3e11, bank.ExposureAud, 1, "voting power over 100, times the market cap")
	assert.Equal(t, int32(1), bank.Holdings)
	assert.Equal(t, "BHP", bank.LargestCode)
	assert.InDelta(t, 6.3, bank.LargestPct, 1e-9)

	// A cell whose holders have no market cap has no exposure, not zero.
	for _, p := range out.Positions {
		if p.Kind == "hedge_fund" {
			assert.False(t, p.HasExposure)
		}
	}
	// The larger exposure sorts first; unknown exposures follow.
	assert.True(t, out.Positions[0].HasExposure)
	assert.Equal(t, "bank_broker", out.Positions[0].Kind)

	require.Len(t, out.Changes, 2)
	assert.Equal(t, "up", out.Changes[0].Direction, "up before down within a cell")
	assert.Equal(t, "down", out.Changes[1].Direction)
	assert.InDelta(t, 8e9, out.Changes[1].ExposureAud, 1, "a magnitude: the direction carries the sign")
}

func TestBuildOwnershipActivityFillsEveryWeek(t *testing.T) {
	u := ownershipFixtureUniverse()
	anchor := time.Date(2026, 10, 16, 0, 0, 0, 0, time.UTC)
	rows := []shortsstore.IndustryWeekRow{
		{Industry: "Materials", WeekStart: "2026-10-05", Became: 1, NetPP: new(4.0)},
	}
	out := buildOwnershipActivity(u, anchor, 3, rows)
	assert.Equal(t, "2026-09-28", out.FromWeek)
	assert.Equal(t, "2026-10-12", out.ToWeek)
	// Industries of the register: "" (MIN and WC8 have no company) and Materials.
	require.Len(t, out.Rows, 6, "two industries, three weeks each")
	byKey := map[string]*shortsv1alpha1.IndustryWeek{}
	for _, r := range out.Rows {
		byKey[r.Industry+"|"+r.WeekStart] = r
	}
	busy := byKey["Materials|2026-10-05"]
	assert.Equal(t, int32(1), busy.Became)
	assert.True(t, busy.HasNetPp)
	assert.InDelta(t, 4, busy.NetPp, 1e-9)
	quiet := byKey["Materials|2026-09-28"]
	assert.Equal(t, int32(0), quiet.Became, "a week with no notice reads zero")
	assert.False(t, quiet.HasNetPp, "and no net figure")
	assert.Equal(t, int32(0), byKey["|2026-10-12"].Became)
	assert.Len(t, buildOwnershipActivity(u, anchor, 52, nil).Rows, 2*52)
}

func TestBuildFundPositionChangesGroupsAndOrders(t *testing.T) {
	u := ownershipFixtureUniverse()
	pairs := []shortsstore.FundPositionPair{
		{InstitutionSlug: "vanguard", FundName: "VAS", StockCode: "ZIP", SecurityName: "ZIP CO", InFrom: true, InTo: true,
			FromWeight: new(0.1), ToWeight: new(0.2), FromValue: new(1500.0), ToValue: new(3000.0)},
		{InstitutionSlug: "vanguard", FundName: "VAS", StockCode: "WBC", InFrom: true,
			FromWeight: new(0.4), FromValue: new(4e9)},
		{InstitutionSlug: "vanguard", FundName: "VAS", StockCode: "PLS", InTo: true,
			ToWeight: new(0.3), ToValue: new(9e8)},
		{InstitutionSlug: "hostplus", FundName: "Balanced", StockCode: "CBA", InFrom: true, InTo: true,
			FromWeight: new(2.0), ToWeight: new(1.0)},
		{InstitutionSlug: "hostplus", FundName: "Balanced", StockCode: "AAA", InFrom: true, InTo: true,
			FromWeight: new(0.5), ToWeight: new(0.9)},
		{InstitutionSlug: "blackrock", FundName: "IOZ", StockCode: "AAA", InFrom: true, InTo: true,
			FromWeight: new(0.1), ToWeight: new(0.1)},
		{InstitutionSlug: "hostplus", FundName: "Balanced", StockCode: "NOW", InFrom: true, InTo: true},
		// A fund that starts holding CBA on the later date moves CBA's weight to, as
		// any holding does: the stock is held by funds on both dates, a change like any.
		{InstitutionSlug: "blackrock", FundName: "IOZ", StockCode: "CBA", InTo: true, ToWeight: new(0.5)},
		// XYZ is held on both dates, by two different funds: a change like any other.
		{InstitutionSlug: "vanguard", FundName: "VAS", StockCode: "XYZ", InFrom: true, FromWeight: new(0.3)},
		{InstitutionSlug: "blackrock", FundName: "IOZ", StockCode: "XYZ", InTo: true, ToWeight: new(0.2)},
	}
	rows := buildFundPositionChanges(u, pairs, 10)
	var codes []string
	states := map[string]string{}
	byCode := map[string]*shortsv1alpha1.FundPositionChange{}
	for _, r := range rows {
		codes = append(codes, r.StockCode)
		states[r.StockCode] = r.State
		byCode[r.StockCode] = r
	}
	assert.Equal(t, []string{"CBA", "AAA", "XYZ", "ZIP", "PLS", "WBC"}, codes,
		"the moves by size (CBA -0.5, AAA +0.4, then XYZ -0.1 and ZIP +0.1 by code), then new, then dropped; "+
			"a stock with no stated weight on a side is in none")
	assert.Equal(t, "current", states["AAA"])
	assert.Equal(t, "new", states["PLS"])
	assert.Equal(t, "dropped", states["WBC"])
	assert.Equal(t, int32(2), byCode["AAA"].Funds)
	assert.InDelta(t, 0.4, byCode["AAA"].DeltaPp, 1e-9, "the sum over the funds on both dates")
	assert.True(t, byCode["AAA"].HasDelta)
	assert.False(t, byCode["PLS"].HasWeightFrom, "a new stock has no earlier weight")
	assert.False(t, byCode["PLS"].HasDelta, "and no change from zero")
	assert.False(t, byCode["WBC"].HasWeightTo)
	assert.InDelta(t, -0.5, byCode["CBA"].DeltaPp, 1e-9, "the funds' sums: 1.0 + 0.5 less 2.0")
	assert.Equal(t, int32(2), byCode["CBA"].Funds, "the funds holding it on either date")
	_, named := byCode["NOW"]
	assert.False(t, named, "held on both dates with no stated weight: no figure, so no delta")
	assert.Equal(t, "ZIP CO", byCode["ZIP"].CompanyName, "the register's name, or the file's security name")
	assert.Equal(t, "current", byCode["XYZ"].State, "held on both dates by different funds: a change")
	assert.InDelta(t, -0.1, byCode["XYZ"].DeltaPp, 1e-9)

	// A current row's weights and values are the sums over the funds holding it on
	// each date, and its delta is weight to less weight from.
	assert.InDelta(t, 0.6, byCode["AAA"].WeightFromPct, 1e-9)
	assert.InDelta(t, 1.0, byCode["AAA"].WeightToPct, 1e-9)
	assert.InDelta(t, byCode["AAA"].DeltaPp, byCode["AAA"].WeightToPct-byCode["AAA"].WeightFromPct, 1e-9,
		"weight to less weight from is the delta")
	assert.InDelta(t, 2.0, byCode["CBA"].WeightFromPct, 1e-9)
	assert.InDelta(t, 1.5, byCode["CBA"].WeightToPct, 1e-9, "IOZ's new 0.5 is in CBA's weight to")
	assert.InDelta(t, 1500.0, byCode["ZIP"].ValueFromAud, 1e-9)
	assert.InDelta(t, 3000.0, byCode["ZIP"].ValueToAud, 1e-9)

	// A new or dropped stock sums the funds on the one date it has.
	assert.InDelta(t, 0.3, byCode["PLS"].WeightToPct, 1e-9)
	assert.InDelta(t, 9e8, byCode["PLS"].ValueToAud, 1e-9)
	assert.InDelta(t, 0.4, byCode["WBC"].WeightFromPct, 1e-9)
	assert.False(t, byCode["WBC"].HasWeightTo)

	// The limit is per direction for the moves, and per group for new and dropped:
	// one rise (AAA), one fall (CBA), ordered by size, then one new and one dropped.
	limited := buildFundPositionChanges(u, pairs, 1)
	require.Len(t, limited, 4)
	assert.Equal(t, "CBA", limited[0].StockCode)
	assert.Equal(t, "AAA", limited[1].StockCode)
	assert.Equal(t, "PLS", limited[2].StockCode)
	assert.Equal(t, "WBC", limited[3].StockCode)
}

func TestBuildStockFundSeriesGroupsByFund(t *testing.T) {
	u := ownershipFixtureUniverse()
	rows := []shortsstore.FundSeriesRow{
		{InstitutionSlug: "hostplus", FundName: "Balanced", SourceKind: "super_phd", AsAt: "2026-06-30", Weight: new(0.7)},
		{InstitutionSlug: "vanguard", FundName: "VAS", SourceKind: "etf", AsAt: "2026-09-30", Weight: new(0.5)},
		{InstitutionSlug: "vanguard", FundName: "VAS", SourceKind: "etf", AsAt: "2026-10-15"},
	}
	out := buildStockFundSeries(u, nil, "BHP", rows)
	require.Len(t, out.Funds, 2)
	assert.Equal(t, "Hostplus", out.Funds[0].InstitutionName)
	assert.Equal(t, "hostplus/Balanced", out.Funds[0].FundKey, "no book: the alias key, which the fund page resolves")
	assert.Empty(t, out.Funds[0].FundCode, "a super option names no ticker, so the page labels it by its name")
	require.Len(t, out.Funds[1].Points, 2)
	assert.True(t, out.Funds[1].Points[0].HasWeight)
	assert.False(t, out.Funds[1].Points[1].HasWeight, "a snapshot with no weight is no weight, not zero")
	assert.Equal(t, "2026-10-15", out.Funds[1].Points[1].AsAt)
}

func TestBuildStockFundSeriesNamesTheRegistryKey(t *testing.T) {
	u := ownershipFixtureUniverse()
	// A registry-matched ETF is keyed as its registry row (the key its fund page resolves under),
	// and carries its ticker; the alias key is what a fund with no registry row keeps.
	files := []shortsstore.FundFileRow{
		{ID: 1, InstitutionSlug: "betashares", InstitutionName: "Betashares", FundName: "Betashares Australia 200 ETF",
			FundCode: "A200", SourceKind: "etf", AsAt: "2026-09-30"},
	}
	registry := []shortsstore.OwnershipFundRow{{FundKey: "asx:A200", InstitutionSlug: "betashares", ASXCode: "A200"}}
	book := buildFundBook(files, registry)
	rows := []shortsstore.FundSeriesRow{
		{InstitutionSlug: "betashares", FundName: "Betashares Australia 200 ETF", FundCode: "A200", SourceKind: "etf",
			AsAt: "2026-09-30", Weight: new(0.5)},
	}
	out := buildStockFundSeries(u, book, "BHP", rows)
	require.Len(t, out.Funds, 1)
	assert.Equal(t, "asx:A200", out.Funds[0].FundKey)
	assert.Equal(t, "A200", out.Funds[0].FundCode)
	assert.Equal(t, "Betashares Australia 200 ETF", out.Funds[0].FundName)
}

func TestDeskMapCachesTheDefaultWindowOnly(t *testing.T) {
	store := deskTestStore(deskNotices())
	s, _ := deskServer(store)
	ctx := context.Background()

	resp, err := s.GetOwnershipMap(ctx, connect.NewRequest(&shortsv1alpha1.GetOwnershipMapRequest{}))
	require.NoError(t, err)
	assert.Equal(t, "2026-07-18", resp.Msg.From)
	assert.Equal(t, "2026-10-16", resp.Msg.To)
	assert.Equal(t, 1, store.readCount("NoticeFlowByStock"))

	_, err = s.GetOwnershipMap(ctx, connect.NewRequest(&shortsv1alpha1.GetOwnershipMapRequest{}))
	require.NoError(t, err)
	assert.Equal(t, 1, store.readCount("NoticeFlowByStock"), "the default window's totals are cached beside the universe")

	_, err = s.GetOwnershipMap(ctx, connect.NewRequest(&shortsv1alpha1.GetOwnershipMapRequest{From: "2026-07-18", To: "2026-10-16"}))
	require.NoError(t, err)
	assert.Equal(t, 2, store.readCount("NoticeFlowByStock"), "a named window is read through")
}

func TestDeskRpcsRefuseBadInput(t *testing.T) {
	s, _ := deskServer(deskTestStore(deskNotices()))
	ctx := context.Background()
	_, err := s.GetOwnershipMap(ctx, connect.NewRequest(&shortsv1alpha1.GetOwnershipMapRequest{From: "2026-02-30"}))
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
	_, err = s.GetOwnershipFlows(ctx, connect.NewRequest(&shortsv1alpha1.GetOwnershipFlowsRequest{From: "2026-10-02", To: "2026-10-01"}))
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
	_, err = s.GetOwnershipActivity(ctx, connect.NewRequest(&shortsv1alpha1.GetOwnershipActivityRequest{Weeks: -1}))
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
	_, err = s.ListFundPositionChanges(ctx, connect.NewRequest(&shortsv1alpha1.ListFundPositionChangesRequest{Limit: -1}))
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
	_, err = s.ListFundPositionChanges(ctx, connect.NewRequest(&shortsv1alpha1.ListFundPositionChangesRequest{From: "16-10-2026"}))
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
	_, err = s.GetStockFundSeries(ctx, connect.NewRequest(&shortsv1alpha1.GetStockFundSeriesRequest{StockCode: "BH-P"}))
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
}

func TestGetOwnershipActivityForwardsTheClampedKind(t *testing.T) {
	store := deskTestStore(deskNotices())
	s, _ := deskServer(store)
	ctx := context.Background()

	_, err := s.GetOwnershipActivity(ctx, connect.NewRequest(&shortsv1alpha1.GetOwnershipActivityRequest{Kind: " Super_Fund "}))
	require.NoError(t, err)
	_, err = s.GetOwnershipActivity(ctx, connect.NewRequest(&shortsv1alpha1.GetOwnershipActivityRequest{}))
	require.NoError(t, err)
	_, err = s.GetOwnershipActivity(ctx, connect.NewRequest(&shortsv1alpha1.GetOwnershipActivityRequest{Kind: "bogus"}))
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
	assert.Equal(t, []string{"super_fund", ""}, store.weeklyKinds, "the clamped kind reaches the store; a refused kind never does")
}

func TestDeskRpcsAnswerEmptyWithoutADeskStore(t *testing.T) {
	clock := &fakeClock{t: ownershipTestNow}
	s := newOwnershipTestServer(newFakeOwnershipStore(ownershipFixture()), clock)
	ctx := context.Background()
	m, err := s.GetOwnershipMap(ctx, connect.NewRequest(&shortsv1alpha1.GetOwnershipMapRequest{}))
	require.NoError(t, err)
	assert.Empty(t, m.Msg.Stocks)
	f, err := s.GetOwnershipFlows(ctx, connect.NewRequest(&shortsv1alpha1.GetOwnershipFlowsRequest{}))
	require.NoError(t, err)
	assert.Empty(t, f.Msg.Positions)
	p, err := s.ListFundPositionChanges(ctx, connect.NewRequest(&shortsv1alpha1.ListFundPositionChangesRequest{}))
	require.NoError(t, err)
	assert.Empty(t, p.Msg.SnapshotDates)
	series, err := s.GetStockFundSeries(ctx, connect.NewRequest(&shortsv1alpha1.GetStockFundSeriesRequest{StockCode: "BHP"}))
	require.NoError(t, err)
	assert.Empty(t, series.Msg.Funds)
}

func TestListFundPositionChangesDefaultsToTheTwoNewestFiles(t *testing.T) {
	store := deskTestStore(nil)
	store.snapshots = []string{"2026-06-30", "2026-09-30", "2026-10-15"}
	store.pairs = []shortsstore.FundPositionPair{
		{InstitutionSlug: "vanguard", FundName: "VAS", StockCode: "ZIP", InFrom: true, InTo: true,
			FromWeight: new(0.1), ToWeight: new(0.2)},
	}
	s, _ := deskServer(store)
	resp, err := s.ListFundPositionChanges(context.Background(), connect.NewRequest(&shortsv1alpha1.ListFundPositionChangesRequest{}))
	require.NoError(t, err)
	assert.Equal(t, "2026-09-30", resp.Msg.From)
	assert.Equal(t, "2026-10-15", resp.Msg.To)
	assert.Equal(t, store.snapshots, resp.Msg.SnapshotDates)
	require.Len(t, resp.Msg.Rows, 1)

	// A to date after the newest file compares the newest two, not the newest with
	// itself: the default from is the file before the one to resolves to.
	after, err := s.ListFundPositionChanges(context.Background(), connect.NewRequest(&shortsv1alpha1.ListFundPositionChangesRequest{To: "2026-10-16"}))
	require.NoError(t, err)
	assert.Equal(t, "2026-09-30", after.Msg.From)
	assert.Equal(t, "2026-10-15", after.Msg.To)
	require.Len(t, after.Msg.Rows, 1)

	// A from before the first file compares from the first file, not nothing.
	before, err := s.ListFundPositionChanges(context.Background(), connect.NewRequest(&shortsv1alpha1.ListFundPositionChangesRequest{From: "2020-01-01"}))
	require.NoError(t, err)
	assert.Equal(t, "2026-06-30", before.Msg.From)
	assert.Equal(t, "2026-10-15", before.Msg.To)
	require.Len(t, before.Msg.Rows, 1)

	// A from after the newest file, with no to, is refused by name: the newest file
	// is the to date the caller did not send.
	_, err = s.ListFundPositionChanges(context.Background(), connect.NewRequest(&shortsv1alpha1.ListFundPositionChangesRequest{From: "2026-11-01"}))
	require.Error(t, err)
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
	assert.ErrorContains(t, err, "from must not be after the newest snapshot, 2026-10-15")

	// A date before every file has no file to compare, and no rows.
	early, err := s.ListFundPositionChanges(context.Background(), connect.NewRequest(&shortsv1alpha1.ListFundPositionChangesRequest{From: "2020-01-01", To: "2020-02-01"}))
	require.NoError(t, err)
	assert.Empty(t, early.Msg.From)
	assert.Empty(t, early.Msg.Rows)
}
