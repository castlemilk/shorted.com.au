package shorts

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"testing"
	"time"

	"cloud.google.com/go/civil"
	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/features"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/snapshot"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/services/shorts/mocks"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// snapshotStoreFake is a store that also serves the daily snapshot. Its
// embedded mock answers every other store call, and an unexpected call fails
// the test, so a snapshot-served read never reaches the views by accident.
type snapshotStoreFake struct {
	*mocks.MockShortsStore
	snap     shortsstore.StrategySnapshot
	snapErr  error
	reads    int
	status   shortsstore.StrategyDataStatus
	events   []shortsstore.StrategySignalEventRow
	evErr    error
	gotEvent shortsstore.StrategySignalEventsFilter
}

func (f *snapshotStoreFake) ReadStrategySnapshot(context.Context) (shortsstore.StrategySnapshot, error) {
	f.reads++
	return f.snap, f.snapErr
}

func (f *snapshotStoreFake) ReadStrategyDataStatus(context.Context) (shortsstore.StrategyDataStatus, error) {
	return f.status, nil
}

func (f *snapshotStoreFake) ListStrategySignalEvents(_ context.Context, flt shortsstore.StrategySignalEventsFilter) ([]shortsstore.StrategySignalEventRow, error) {
	f.gotEvent = flt
	return f.events, f.evErr
}

// snapRow is a stored row for one priced stock with the given priced sessions.
func snapRow(day civil.Date, code string, priced int) snapshot.Row {
	report := civil.Date{Year: 2026, Month: time.October, Day: 28}
	pct := 6.5
	return snapshot.Row{
		AsOf:            day,
		FeatureSet:      "fs1",
		StockCode:       code,
		OrdinaryFresh60: true,
		IsOrdinary:      true,
		Features: snapshot.Features{
			FS1: features.PriceFeatures{AsOf: day, Close: 10},
			SF0: features.ShortReading{Pct: &pct, ReportDate: &report},
		},
		Meta: []byte(`{"name":"` + code + ` Ltd","priced_sessions":` + strconv.Itoa(priced) + `}`),
	}
}

func snapDay() civil.Date { return civil.Date{Year: 2026, Month: time.September, Day: 25} }

// snapshotOf is a completed session with two stocks priced, and one not.
func snapshotOf() shortsstore.StrategySnapshot {
	day := snapDay()
	return shortsstore.StrategySnapshot{
		AsOf:     day,
		PrevAsOf: civil.Date{Year: 2026, Month: time.September, Day: 24},
		Rows: []snapshot.Row{
			snapRow(day, "BHP", 120),
			snapRow(day, "CBA", 60),
			snapRow(day, "NEW", 59), // under the 60-session minimum: not a candidate
		},
		Regime: engine.Regime{IndexCode: "XJO", AsOf: ptrTime(day), Label: engine.RegimeUptrend},
	}
}

func ptrTime(d civil.Date) *time.Time {
	t := time.Date(d.Year, d.Month, d.Day, 0, 0, 0, 0, time.UTC)
	return &t
}

// The snapshot's rows are the candidates the live universe policy accepts, in
// code order, and the regime is the snapshot's.
func TestSnapshotCandidates_KeepsTheLiveUniverseOnly(t *testing.T) {
	cands, err := snapshotCandidates(snapshotOf())
	require.NoError(t, err)
	require.Len(t, cands, 2)
	assert.Equal(t, "BHP", cands[0].StockCode)
	assert.Equal(t, "CBA", cands[1].StockCode)
	assert.Equal(t, "BHP Ltd", cands[0].CompanyName)
	require.NotNil(t, cands[0].ShortPct)
	assert.InDelta(t, 6.5, *cands[0].ShortPct, 1e-9)
}

// The live specs share one universe policy: the snapshot universe is built
// once for all of them, so they must agree on it.
func TestLiveSpecsShareOneUniversePolicy(t *testing.T) {
	first, ok := spec.Live(spec.StrategyZangerBreakout)
	require.True(t, ok)
	for _, id := range []string{spec.StrategyCANSLIM, spec.StrategyMinerviniTrend, spec.StrategyCrowdedShortBreakout, spec.StrategyQualityCompounders} {
		r, ok := spec.Live(id)
		require.True(t, ok, id)
		assert.Equal(t, first.Spec.Universe, r.Spec.Universe, id)
		assert.Equal(t, first.Spec.Data.ShortSource, r.Spec.Data.ShortSource, id)
	}
}

// With the snapshot source, the universe is the snapshot's session and regime,
// and the views are never read.
func TestSnapshotSourceServesTheSnapshotUniverse(t *testing.T) {
	ctrl := gomock.NewController(t)
	fake := &snapshotStoreFake{MockShortsStore: mocks.NewMockShortsStore(ctrl), snap: snapshotOf()}
	srv := newTestServer(t, fake)
	srv.config.StrategySource = StrategySourceSnapshot

	u, err := srv.loadStrategyUniverse(context.Background())
	require.NoError(t, err)
	assert.Equal(t, "2026-09-25", u.asOf, "session_date comes from the snapshot")
	assert.Equal(t, engine.RegimeUptrend, u.regime.Label)
	assert.Len(t, u.candidates, 2)
	assert.Equal(t, 1, fake.reads)

	// Served from the cache on the second call.
	_, err = srv.loadStrategyUniverse(context.Background())
	require.NoError(t, err)
	assert.Equal(t, 1, fake.reads)
}

// The views source never reads the snapshot: the flag selects the source.
func TestViewsSourceNeverReadsTheSnapshot(t *testing.T) {
	ctrl := gomock.NewController(t)
	mockStore := mocks.NewMockShortsStore(ctrl)
	mockStore.EXPECT().ListStrategyCandidates(gomock.Any()).Return(spUniverse(), nil)
	mockStore.EXPECT().GetMarketRegime(gomock.Any(), "XJO").Return(spUptrend(), nil)
	fake := &snapshotStoreFake{MockShortsStore: mockStore, snap: snapshotOf()}
	srv := newTestServer(t, fake)
	srv.config.StrategySource = StrategySourceViews

	_, err := srv.loadStrategyUniverse(context.Background())
	require.NoError(t, err)
	assert.Equal(t, 0, fake.reads)
}

// A database without the snapshot tables, or without a completed session,
// serves the views (the fallback), and the caller never sees an error.
func TestSnapshotSourceFallsBackToTheViews(t *testing.T) {
	cases := map[string]error{
		"tables not migrated":  shortsstore.ErrStrategySnapshotUnavailable,
		"no completed session": shortsstore.ErrNoStrategySnapshot,
	}
	for name, readErr := range cases {
		t.Run(name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			mockStore := mocks.NewMockShortsStore(ctrl)
			mockStore.EXPECT().ListStrategyCandidates(gomock.Any()).Return(spUniverse(), nil)
			mockStore.EXPECT().GetMarketRegime(gomock.Any(), "XJO").Return(spUptrend(), nil)
			fake := &snapshotStoreFake{MockShortsStore: mockStore, snapErr: readErr}
			srv := newTestServer(t, fake)
			srv.config.StrategySource = StrategySourceSnapshot

			u, err := srv.loadStrategyUniverse(context.Background())
			require.NoError(t, err)
			assert.Equal(t, "2026-09-25", u.asOf, "the views' newest price date")
		})
	}
}

// A failure other than the two fallbacks is an error, not a silent view.
func TestSnapshotSourceReturnsOtherErrors(t *testing.T) {
	ctrl := gomock.NewController(t)
	fake := &snapshotStoreFake{MockShortsStore: mocks.NewMockShortsStore(ctrl), snapErr: errors.New("timeout")}
	srv := newTestServer(t, fake)
	srv.config.StrategySource = StrategySourceSnapshot

	_, err := srv.loadStrategyUniverse(context.Background())
	require.Error(t, err)
}

// The status of the source dates: the snapshot session, the sweep, the ASIC
// reports (complete when every code is loaded) and the next weekday refresh.
func TestStrategyDataStatusReportsTheSourceDates(t *testing.T) {
	ctrl := gomock.NewController(t)
	sweep := time.Date(2026, 9, 25, 6, 0, 0, 0, time.UTC)
	fake := &snapshotStoreFake{MockShortsStore: mocks.NewMockShortsStore(ctrl), status: shortsstore.StrategyDataStatus{
		LatestSession:       "2026-09-25",
		PricesCompletedAt:   &sweep,
		SnapshotAsOf:        "2026-09-25",
		SnapshotCompletedAt: &sweep,
		PricedCodes:         2400,
		AsicReports: []shortsstore.AsicReportRow{
			{ReportDate: civil.Date{Year: 2026, Month: time.October, Day: 28}, FirstIngestedAt: sweep, FileRows: intPtr(100), LoadedRows: 100},
			{ReportDate: civil.Date{Year: 2026, Month: time.October, Day: 27}, FirstIngestedAt: sweep, FileRows: intPtr(100), LoadedRows: 99},
		},
	}}
	srv := newTestServer(t, fake)

	resp, err := srv.GetStrategyDataStatus(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStrategyDataStatusRequest{}))
	require.NoError(t, err)
	m := resp.Msg
	assert.Equal(t, "2026-09-25", m.SnapshotAsOf)
	assert.Equal(t, "2026-09-25T06:00:00Z", m.PricesCompletedAt)
	assert.Equal(t, int32(2400), m.PricedCodes)
	require.Len(t, m.AsicReports, 2)
	assert.True(t, m.AsicReports[0].Complete)
	assert.False(t, m.AsicReports[1].Complete, "99 of 100 codes is not complete")
	assert.NotEmpty(t, m.AsicReports[0].AvailableDate)
	assert.Equal(t, "2026-10-28", m.AsicReports[0].ReportDate)
	assert.NotEmpty(t, m.NextUpdateUtc)
}

func intPtr(v int) *int { return &v }

// The next refresh is the next weekday 13:30 UTC strictly after the instant.
func TestNextPicksRefreshIsTheNextWeekday1330UTC(t *testing.T) {
	cases := map[string]struct{ now, want time.Time }{
		"friday before the refresh": {time.Date(2026, 1, 2, 13, 0, 0, 0, time.UTC), time.Date(2026, 1, 2, 13, 30, 0, 0, time.UTC)},
		"friday after the refresh":  {time.Date(2026, 1, 2, 14, 0, 0, 0, time.UTC), time.Date(2026, 1, 5, 13, 30, 0, 0, time.UTC)},
		"saturday":                  {time.Date(2026, 1, 3, 10, 0, 0, 0, time.UTC), time.Date(2026, 1, 5, 13, 30, 0, 0, time.UTC)},
	}
	for name, c := range cases {
		assert.Equal(t, c.want, nextPicksRefresh(c.now), name)
	}
}

// Signal events are served to every signed-in access level and refused to an
// anonymous caller; the default version is the live one.
func TestListStrategySignalEvents_AccessLevels(t *testing.T) {
	live, ok := spec.Live(spec.StrategyZangerBreakout)
	require.True(t, ok)
	liveHash, err := spec.RulesHash(live.Spec)
	require.NoError(t, err)

	score := 71.5
	ctrl := gomock.NewController(t)
	fake := &snapshotStoreFake{MockShortsStore: mocks.NewMockShortsStore(ctrl), events: []shortsstore.StrategySignalEventRow{{
		ID: 9, StockCode: "BHP", CompanyName: "BHP Group", AsOf: "2026-09-25", PrevAsOf: "2026-09-24",
		FromStatus: "setup", ToStatus: "triggered", Score: &score, RulesHash: liveHash,
		Evidence: `{"r":["breakout"],"v":[9.5],"p":[null],"close":10.2,"pivot":9.5}`,
	}}}
	srv := newTestServer(t, fake)
	req := &shortsv1alpha1.ListStrategySignalEventsRequest{StrategyId: spec.StrategyZangerBreakout, StockCode: "bhp"}

	_, err = srv.ListStrategySignalEvents(context.Background(), connect.NewRequest(req))
	assert.Equal(t, connect.CodeUnauthenticated, connect.CodeOf(err), "anonymous is refused")

	for _, ctx := range []context.Context{userContext("free"), premiumContextFor()} {
		resp, err := srv.ListStrategySignalEvents(ctx, connect.NewRequest(req))
		require.NoError(t, err)
		require.Len(t, resp.Msg.Events, 1)
		ev := resp.Msg.Events[0]
		assert.Equal(t, "BHP", ev.StockCode)
		assert.Equal(t, "setup", ev.FromStatus)
		assert.Equal(t, "triggered", ev.ToStatus)
		assert.True(t, ev.HasPivot)
		assert.InDelta(t, 9.5, ev.Pivot, 1e-9)
		require.Len(t, ev.Rules, 1)
		assert.Equal(t, "breakout", ev.Rules[0].RuleId)
		assert.True(t, ev.Rules[0].HasValue)
		assert.False(t, ev.Rules[0].HasProximity)
		assert.Empty(t, resp.Msg.NextPageToken)
	}
	assert.Equal(t, liveHash, fake.gotEvent.RulesHash, "the default version is the live one")
	assert.Equal(t, "BHP", fake.gotEvent.StockCode)
}

// A variant's hash, or any hash the registry does not publish, is NotFound: the
// public and private readers serve canonical versions only.
func TestListStrategySignalEvents_NeverServesAVariant(t *testing.T) {
	ctrl := gomock.NewController(t)
	fake := &snapshotStoreFake{MockShortsStore: mocks.NewMockShortsStore(ctrl)}
	srv := newTestServer(t, fake)

	_, err := srv.ListStrategySignalEvents(userContext("free"), connect.NewRequest(&shortsv1alpha1.ListStrategySignalEventsRequest{
		StrategyId:  spec.StrategyZangerBreakout,
		VersionHash: strings.Repeat("9f", 32),
	}))
	assert.Equal(t, connect.CodeNotFound, connect.CodeOf(err))
	assert.Equal(t, 0, fake.reads, "a refused hash never reaches the store")
}

// The page token pages by id, newest first: a full page carries the id of its
// last row as the next token, and the extra row probed for it is not returned.
func TestListStrategySignalEvents_Paging(t *testing.T) {
	ctrl := gomock.NewController(t)
	rows := []shortsstore.StrategySignalEventRow{{ID: 30}, {ID: 29}, {ID: 28}}
	fake := &snapshotStoreFake{MockShortsStore: mocks.NewMockShortsStore(ctrl), events: rows}
	srv := newTestServer(t, fake)

	resp, err := srv.ListStrategySignalEvents(userContext("free"), connect.NewRequest(&shortsv1alpha1.ListStrategySignalEventsRequest{
		StrategyId: spec.StrategyZangerBreakout, PageSize: 2,
	}))
	require.NoError(t, err)
	assert.Len(t, resp.Msg.Events, 2)
	assert.Equal(t, "29", resp.Msg.NextPageToken)
	assert.Equal(t, 3, fake.gotEvent.Limit, "one row past the page, to know there is another")

	_, err = srv.ListStrategySignalEvents(userContext("free"), connect.NewRequest(&shortsv1alpha1.ListStrategySignalEventsRequest{
		StrategyId: spec.StrategyZangerBreakout, PageToken: "bogus",
	}))
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
}

// A store without the snapshot (the views-only build) reads no events, not an error.
func TestListStrategySignalEvents_NoSnapshotIsEmpty(t *testing.T) {
	ctrl := gomock.NewController(t)
	fake := &snapshotStoreFake{MockShortsStore: mocks.NewMockShortsStore(ctrl), evErr: shortsstore.ErrStrategySnapshotUnavailable}
	srv := newTestServer(t, fake)

	resp, err := srv.ListStrategySignalEvents(userContext("free"), connect.NewRequest(&shortsv1alpha1.ListStrategySignalEventsRequest{
		StrategyId: spec.StrategyZangerBreakout,
	}))
	require.NoError(t, err)
	assert.Empty(t, resp.Msg.Events)
}

// premiumContextFor is a signed-in premium caller (the tier resolved).
func premiumContextFor() context.Context {
	return context.WithValue(context.Background(), userKey, &Claims{
		UserID: "user_premium", Email: "p@shorted.com.au", EmailVerified: true, Tier: "premium", TierResolved: true,
	})
}
