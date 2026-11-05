package shorts

import (
	"context"
	"encoding/json"
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
	"google.golang.org/protobuf/proto"

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
	// evReads counts the event reads, statusReads the data status reads.
	evReads     int
	statusReads int
}

func (f *snapshotStoreFake) ReadStrategySnapshot(context.Context) (shortsstore.StrategySnapshot, error) {
	f.reads++
	return f.snap, f.snapErr
}

func (f *snapshotStoreFake) ReadStrategyDataStatus(context.Context) (shortsstore.StrategyDataStatus, error) {
	f.statusReads++
	return f.status, nil
}

func (f *snapshotStoreFake) ListStrategySignalEvents(_ context.Context, flt shortsstore.StrategySignalEventsFilter) ([]shortsstore.StrategySignalEventRow, error) {
	f.evReads++
	f.gotEvent = flt
	return f.events, f.evErr
}

// snapRow is a stored row for one priced stock with the given priced sessions.
func snapRow(day civil.Date, code string, priced int) snapshot.Row {
	report := civil.Date{Year: 2026, Month: time.October, Day: 28}
	pct := 6.5
	inReport := true
	return snapshot.Row{
		AsOf:       day,
		FeatureSet: "fs1",
		StockCode:  code,
		// ordinary_fresh_60 is the job's: a priced bar on the session and 60 priced sessions.
		OrdinaryFresh60: priced >= 60,
		IsOrdinary:      true,
		InASICReport:    true,
		Features: snapshot.Features{
			FS1: features.PriceFeatures{AsOf: day, Close: 10},
			SF0: features.ShortReading{Pct: &pct, ReportDate: &report},
			SF1: features.ShortReading{Status: features.StatusReported, Pct: &pct, ReportDate: &report, InReport: &inReport},
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
		// Crowded-Short's universe also names the ASIC report; the shared
		// policy is the rest, and that one is the strategy's own (strategyCandidates).
		want, got := first.Spec.Universe, r.Spec.Universe
		want.ASICReported, got.ASICReported = false, false
		assert.Equal(t, want, got, id)
		assert.Equal(t, first.Spec.Data.ShortSource, r.Spec.Data.ShortSource, id)
	}
	crowded, _ := spec.Live(spec.StrategyCrowdedShortBreakout)
	assert.True(t, crowded.Spec.Universe.ASICReported, "Crowded-Short ranks only the names the report lists")
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
	assert.Equal(t, StrategySourceSnapshot, u.source, "the universe names the source that answered")
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
			// The views answer v0 whatever the source says, so no fallback is labelled v1.
			for _, id := range []string{spec.StrategyCrowdedShortBreakout, spec.StrategyZangerBreakout} {
				assert.Equal(t, "v0", u.served[id].reg.Label, id)
				assert.False(t, u.served[id].reg.Spec.Ladder.UnknownStatus, id)
			}
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
			{ReportDate: civil.Date{Year: 2026, Month: time.October, Day: 28}, FirstIngestedAt: sweep, FileRows: intPtr(100), LoadedRows: 100, AvailableDate: &civil.Date{Year: 2026, Month: time.November, Day: 3}},
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
	assert.Equal(t, "2026-11-03", m.AsicReports[0].AvailableDate, "the date the store derived from the snapshot calendar")
	assert.Empty(t, m.AsicReports[1].AvailableDate, "a report the store did not date names no date")
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
		Evidence: signalEvidenceJSON(t, live.Spec, "P"+strings.Repeat("F", len(live.Spec.Rules)-2)+"U", 10.2, 9.5),
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
		require.Len(t, ev.Rules, len(live.Spec.Rules))
		assert.Equal(t, live.Spec.Rules[0].ID, ev.Rules[0].RuleId)
		assert.Equal(t, "pass", ev.Rules[0].Status)
		assert.True(t, ev.Rules[0].HasValue)
		assert.False(t, ev.Rules[0].HasProximity)
		assert.Equal(t, "fail", ev.Rules[1].Status)
		assert.Equal(t, "unknown", ev.Rules[len(ev.Rules)-1].Status)
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
	assert.Equal(t, 0, fake.evReads, "a refused hash never reaches the store")
}

// The page token pages by id, newest first: a full page carries the id of its
// last row as the next token, and the extra row probed for it is not returned.
func TestListStrategySignalEvents_Paging(t *testing.T) {
	ctrl := gomock.NewController(t)
	live, ok := spec.Live(spec.StrategyZangerBreakout)
	require.True(t, ok)
	liveHash, err := spec.RulesHash(live.Spec)
	require.NoError(t, err)
	rows := []shortsstore.StrategySignalEventRow{{ID: 30, RulesHash: liveHash}, {ID: 29, RulesHash: liveHash}, {ID: 28, RulesHash: liveHash}}
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

// The public readers never serve a variant: the version reads answer NotFound
// for a variant's hash and list only canonical versions, and the events reader
// (private) reads nothing for a variant hash either.
func TestPublicReadersNeverReturnVariants(t *testing.T) {
	ctrl := gomock.NewController(t)
	live, ok := spec.Live(spec.StrategyZangerBreakout)
	require.True(t, ok)
	liveHash, err := spec.RulesHash(live.Spec)
	require.NoError(t, err)
	variant := strings.Repeat("3", 64)
	// The store is asked for the live version, and hands back a variant's row too:
	// the handler drops it, so the variant event never reaches a caller.
	fake := &snapshotStoreFake{MockShortsStore: mocks.NewMockShortsStore(ctrl), events: []shortsstore.StrategySignalEventRow{
		{ID: 2, StockCode: "BHP", RulesHash: variant, FromStatus: "setup", ToStatus: "triggered", Evidence: `{}`},
		{ID: 1, StockCode: "BHP", RulesHash: liveHash, FromStatus: "setup", ToStatus: "triggered", Evidence: `{}`},
	}}
	srv := newTestServer(t, fake)

	_, err = srv.GetStrategyVersion(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStrategyVersionRequest{
		StrategyId: spec.StrategyZangerBreakout, VersionHash: variant,
	}))
	assert.Equal(t, connect.CodeNotFound, connect.CodeOf(err), "a variant hash is not a published version")

	list, err := srv.ListStrategyVersions(context.Background(), connect.NewRequest(&shortsv1alpha1.ListStrategyVersionsRequest{}))
	require.NoError(t, err)
	for _, v := range list.Msg.Versions {
		assert.NotEqual(t, variant, v.Version.RulesHash)
		assert.Equal(t, "canonical", v.Version.Kind, v.Version.StrategyId)
	}

	_, err = srv.ListStrategySignalEvents(userContext("free"), connect.NewRequest(&shortsv1alpha1.ListStrategySignalEventsRequest{
		StrategyId: spec.StrategyZangerBreakout, VersionHash: variant,
	}))
	assert.Equal(t, connect.CodeNotFound, connect.CodeOf(err))

	events, err := srv.ListStrategySignalEvents(userContext("free"), connect.NewRequest(&shortsv1alpha1.ListStrategySignalEventsRequest{
		StrategyId: spec.StrategyZangerBreakout,
	}))
	require.NoError(t, err)
	require.Len(t, events.Msg.Events, 1, "the variant's row is dropped")
	assert.Equal(t, liveHash, events.Msg.Events[0].RulesHash, "only the live version's row is served")
}

// The snapshot's stored publication date is the one the picks show: a short date
// the calendar would derive differently (a day the index has no bar) is not
// recomputed on the snapshot path.
func TestSnapshotShortAvailableDateIsTheStoredOne(t *testing.T) {
	snap := snapshotOf()
	stored := civil.Date{Year: 2026, Month: time.November, Day: 2}
	snap.Rows[0].Features.SF0.AvailableDate = &stored
	snap.Rows[0].Features.SF1.AvailableDate = &stored
	cands, err := snapshotCandidates(snap)
	require.NoError(t, err)
	require.NotNil(t, cands[0].ShortAvailableDate)
	assert.Equal(t, "2026-11-02", cands[0].ShortAvailableDate.Format("2006-01-02"))

	report := time.Date(2026, 10, 28, 0, 0, 0, 0, time.UTC)
	_, calendar := shortDatesProto(&report, nil)
	_, fromSnapshot := shortDatesProto(&report, cands[0].ShortAvailableDate)
	assert.Equal(t, "2026-11-02", fromSnapshot)
	assert.NotEmpty(t, calendar, "without a stored date the ASX calendar derives it")

	// A report before the holiday table's first year names no date on either path,
	// as the views do, even when the snapshot stores one.
	old := time.Date(2025, 12, 15, 0, 0, 0, 0, time.UTC)
	storedOld := time.Date(2025, 12, 19, 0, 0, 0, 0, time.UTC)
	reportedOld, availableOld := shortDatesProto(&old, &storedOld)
	assert.Equal(t, "2025-12-15", reportedOld)
	assert.Empty(t, availableOld)
	_, calendarOld := shortDatesProto(&old, nil)
	assert.Empty(t, calendarOld)
}

// The next refresh skips the ASX's non-trading days: Christmas and the day after
// have no session, so the field never names one.
func TestNextPicksRefreshSkipsNonTradingDays(t *testing.T) {
	now := time.Date(2026, 12, 24, 14, 0, 0, 0, time.UTC)
	assert.Equal(t, time.Date(2026, 12, 29, 13, 30, 0, 0, time.UTC), nextPicksRefresh(now))
}

// The snapshot's first run is 13:00 UTC on the next trading day.
func TestNextSnapshotRunIsTheNextTradingDay1300UTC(t *testing.T) {
	assert.Equal(t, time.Date(2026, 1, 5, 13, 0, 0, 0, time.UTC), nextSnapshotRun(time.Date(2026, 1, 2, 14, 0, 0, 0, time.UTC)))
}

// The hub's regime is the snapshot's under the snapshot source, and the views
// are not read for it.
func TestListStrategiesRegimeFollowsTheSnapshotSource(t *testing.T) {
	ctrl := gomock.NewController(t)
	fake := &snapshotStoreFake{MockShortsStore: mocks.NewMockShortsStore(ctrl), snap: snapshotOf()}
	srv := newTestServer(t, fake)
	srv.config.StrategySource = StrategySourceSnapshot

	resp, err := srv.ListStrategies(context.Background(), connect.NewRequest(&shortsv1alpha1.ListStrategiesRequest{}))
	require.NoError(t, err)
	snap := snapshotOf()
	want := marketRegimeProto(snap.Regime, engine.NeutralRegimeVerdict(snap.Regime))
	assert.True(t, proto.Equal(want, resp.Msg.Regime), "the banner is the snapshot's regime")
}

// The data status is cached per instance: a second read answers from the cache.
func TestGetStrategyDataStatusIsCached(t *testing.T) {
	ctrl := gomock.NewController(t)
	fake := &snapshotStoreFake{MockShortsStore: mocks.NewMockShortsStore(ctrl), status: shortsstore.StrategyDataStatus{SnapshotAsOf: "2026-09-25"}}
	srv := newTestServer(t, fake)
	for range 2 {
		resp, err := srv.GetStrategyDataStatus(context.Background(), connect.NewRequest(&shortsv1alpha1.GetStrategyDataStatusRequest{}))
		require.NoError(t, err)
		assert.Equal(t, "2026-09-25", resp.Msg.SnapshotAsOf)
	}
	assert.Equal(t, 1, fake.statusReads)
}

// A stored evidence document that does not decode is reported as an error, and the
// event still reads with empty rules rather than failing the page.
func TestSignalEventProtoReportsUndecodableEvidence(t *testing.T) {
	ev, err := signalEventProto(shortsstore.StrategySignalEventRow{StockCode: "BHP", FromStatus: "setup", ToStatus: "triggered", Evidence: "not json"})
	require.Error(t, err)
	assert.Equal(t, "BHP", ev.StockCode)
	assert.Empty(t, ev.Rules)
}

// signalEvidenceJSON is a stored evidence document for a rules version: r as
// given, rule 0's value 9.5 and rule 1's proximity 0.82 (every other value and
// proximity null), and the close and pivot.
func signalEvidenceJSON(t *testing.T, s spec.Spec, r string, closePrice, pivot float64) string {
	t.Helper()
	n := len(s.Rules)
	ev := signalEvidence{R: r, V: make([]*float64, n), P: make([]*float64, n), Close: &closePrice, Pivot: &pivot}
	v0, p1 := 9.5, 0.82
	ev.V[0] = &v0
	if n > 1 {
		ev.P[1] = &p1
	}
	raw, err := json.Marshal(ev)
	require.NoError(t, err)
	return string(raw)
}

// Each status character decodes to its rule, in the rules version's order, with
// the value and proximity stored beside it.
func TestSignalEventProto_DecodesEachRuleStatus(t *testing.T) {
	reg, ok := spec.Live(spec.StrategyZangerBreakout)
	require.True(t, ok)
	h, err := spec.RulesHash(reg.Spec)
	require.NoError(t, err)
	n := len(reg.Spec.Rules)
	chars := make([]byte, n)
	for i := range chars {
		chars[i] = "PFU"[i%3]
	}
	ev, err := signalEventProto(shortsstore.StrategySignalEventRow{
		StockCode: "BHP", FromStatus: "setup", ToStatus: "triggered", RulesHash: h,
		Evidence: signalEvidenceJSON(t, reg.Spec, string(chars), 10.2, 9.5),
	})
	require.NoError(t, err)
	require.Len(t, ev.Rules, n)
	want := map[byte]string{'P': "pass", 'F': "fail", 'U': "unknown"}
	for i, rr := range ev.Rules {
		assert.Equal(t, reg.Spec.Rules[i].ID, rr.RuleId, "rule %d id, in the version's order", i)
		assert.Equal(t, want[chars[i]], rr.Status, "rule %d status", i)
	}
	assert.True(t, ev.Rules[0].HasValue)
	assert.InDelta(t, 9.5, ev.Rules[0].Value, 1e-9)
	assert.False(t, ev.Rules[0].HasProximity)
	assert.True(t, ev.Rules[1].HasProximity)
	assert.InDelta(t, 0.82, ev.Rules[1].Proximity, 1e-9)
	assert.InDelta(t, 10.2, ev.Close, 1e-9)
	assert.True(t, ev.HasPivot)
}

// An exit has no pick: r is "", v and p are empty, and the event has no rules.
func TestSignalEventProto_ExitHasNoRules(t *testing.T) {
	reg, ok := spec.Live(spec.StrategyZangerBreakout)
	require.True(t, ok)
	h, err := spec.RulesHash(reg.Spec)
	require.NoError(t, err)
	ev, err := signalEventProto(shortsstore.StrategySignalEventRow{
		StockCode: "BHP", FromStatus: "triggered", ToStatus: "none", RulesHash: h,
		Evidence: `{"r":"","v":[],"p":[],"close":null,"pivot":null,"short_report":null,"short_available":null,"regime":null}`,
	})
	require.NoError(t, err)
	assert.Empty(t, ev.Rules)
	assert.Equal(t, "none", ev.ToStatus)
}

// Evidence that does not fit its rules version (a length mismatch, an unknown or
// lower-case status character, rule results on an exit, a rules hash the registry
// does not hold) is an error, and the event is served with no rule results rather
// than with rules taken from the wrong version. Its close still reads.
func TestSignalEventProto_MalformedEvidenceServesNoRules(t *testing.T) {
	reg, ok := spec.Live(spec.StrategyZangerBreakout)
	require.True(t, ok)
	h, err := spec.RulesHash(reg.Spec)
	require.NoError(t, err)
	n := len(reg.Spec.Rules)
	full := strings.Repeat("P", n)
	nils := func(k int) []*float64 { return make([]*float64, k) }
	const closePrice = 10.2
	cases := []struct {
		name string
		hash string
		to   string
		ev   signalEvidence
	}{
		{"fewer statuses than rules", h, "triggered", signalEvidence{R: full[:n-1], V: nils(n), P: nils(n)}},
		{"more statuses than rules", h, "triggered", signalEvidence{R: full + "P", V: nils(n + 1), P: nils(n + 1)}},
		{"more statuses than values", h, "triggered", signalEvidence{R: full + "P", V: nils(n), P: nils(n)}},
		{"values short of the statuses", h, "triggered", signalEvidence{R: full, V: nils(n - 1), P: nils(n)}},
		{"proximities short of the statuses", h, "triggered", signalEvidence{R: full, V: nils(n), P: nils(n - 1)}},
		{"no statuses on a pick", h, "triggered", signalEvidence{R: "", V: []*float64{}, P: []*float64{}}},
		{"unknown status character", h, "triggered", signalEvidence{R: "X" + full[1:], V: nils(n), P: nils(n)}},
		{"lower-case status", h, "triggered", signalEvidence{R: "p" + full[1:], V: nils(n), P: nils(n)}},
		{"rule results on an exit", h, "none", signalEvidence{R: "P", V: nils(1), P: nils(1)}},
		{"values on an exit", h, "none", signalEvidence{R: "", V: nils(1), P: nils(0)}},
		{"proximities on an exit", h, "none", signalEvidence{R: "", V: nils(0), P: nils(1)}},
		{"rules hash not registered", strings.Repeat("9f", 32), "triggered", signalEvidence{R: full, V: nils(n), P: nils(n)}},
	}
	for _, c := range cases {
		c.ev.Close = new(float64)
		*c.ev.Close = closePrice
		raw, err := json.Marshal(c.ev)
		require.NoError(t, err, c.name)
		ev, err := signalEventProto(shortsstore.StrategySignalEventRow{
			StockCode: "BHP", FromStatus: "setup", ToStatus: c.to, RulesHash: c.hash, Evidence: string(raw),
		})
		require.Error(t, err, c.name)
		assert.Empty(t, ev.Rules, c.name)
		assert.InDelta(t, closePrice, ev.Close, 1e-9, c.name)
		assert.Equal(t, "BHP", ev.StockCode, c.name)
	}
}

// The evidence as the store returns it: the jsonb text Postgres prints, its keys
// reordered and spaced, not the reader's own marshalling. It pins the key names
// and the one-string form that the job writes. Zanger's rules are growth, base,
// breakout (the trigger), regime, rs and liquidity, so PFFPUP reads pass, fail,
// fail (the breakout, waiting on a setup), pass, unknown, pass.
func TestSignalEventProto_DecodesStoredEvidenceText(t *testing.T) {
	reg, ok := spec.Live(spec.StrategyZangerBreakout)
	require.True(t, ok)
	h, err := spec.RulesHash(reg.Spec)
	require.NoError(t, err)
	require.Len(t, reg.Spec.Rules, 6, "the stored text below is the six Zanger rules")
	const stored = `{"p": [null, null, 0.82, null, null, null], "r": "PFFPUP", "v": [9.5, null, null, 1, null, 19200000], "close": 41.20, "pivot": 41.64, "short_report": "2026-10-28", "short_available": "2026-11-03", "regime": "neutral"}`
	row := shortsstore.StrategySignalEventRow{StockCode: "ZNG", FromStatus: "watch", ToStatus: "setup", RulesHash: h, Evidence: stored}

	ev, err := signalEventProto(row)
	require.NoError(t, err)
	wantIDs := []string{"growth", "base", "breakout", "regime", "rs", "liquidity"}
	wantStatus := []string{"pass", "fail", "fail", "pass", "unknown", "pass"}
	require.Len(t, ev.Rules, len(wantIDs))
	for i, rr := range ev.Rules {
		assert.Equal(t, wantIDs[i], rr.RuleId, "rule %d id", i)
		assert.Equal(t, wantStatus[i], rr.Status, "rule %d status", i)
	}
	assert.True(t, ev.Rules[0].HasValue)
	assert.InDelta(t, 9.5, ev.Rules[0].Value, 1e-9)
	assert.True(t, ev.Rules[2].HasProximity)
	assert.InDelta(t, 0.82, ev.Rules[2].Proximity, 1e-9)
	assert.True(t, ev.Rules[5].HasValue)
	assert.InDelta(t, 19200000, ev.Rules[5].Value, 1e-9)
	assert.True(t, ev.Rules[2].Waiting, "a failing breakout on a setup row is what the stock waits for")
	assert.False(t, ev.Rules[1].Waiting, "a failing non-trigger rule never waits")
	assert.InDelta(t, 41.20, ev.Close, 1e-9)
	assert.True(t, ev.HasPivot)
	assert.InDelta(t, 41.64, ev.Pivot, 1e-9)

	row.ToStatus = "triggered"
	ev, err = signalEventProto(row)
	require.NoError(t, err)
	require.Len(t, ev.Rules, len(wantIDs))
	assert.False(t, ev.Rules[2].Waiting, "a triggered row is not waiting")
	assert.Equal(t, "fail", ev.Rules[2].Status)
}

// A mistyped field does not stop encoding/json: it skips that field, fills the
// rest, and returns the first type error at the end. The event keeps the close
// and pivot that were read and serves no rules.
func TestSignalEventProto_MistypedEvidenceKeepsCloseAndPivot(t *testing.T) {
	ev, err := signalEventProto(shortsstore.StrategySignalEventRow{
		StockCode: "BHP", FromStatus: "setup", ToStatus: "triggered",
		Evidence: `{"r":["breakout","near_high"],"v":[1],"p":[null],"close":41.2,"pivot":41.64}`,
	})
	require.Error(t, err)
	assert.Equal(t, "BHP", ev.StockCode)
	assert.InDelta(t, 41.2, ev.Close, 1e-9)
	assert.True(t, ev.HasPivot)
	assert.InDelta(t, 41.64, ev.Pivot, 1e-9)
	assert.Empty(t, ev.Rules)
}

// A string close or pivot is not a price: it is served as absent, never as 0 with
// has_pivot set, even when the rules fail to decode too.
func TestSignalEventProto_MistypedPriceIsNotServed(t *testing.T) {
	ev, err := signalEventProto(shortsstore.StrategySignalEventRow{
		StockCode: "BHP", FromStatus: "setup", ToStatus: "triggered",
		Evidence: `{"r":"PF","v":[1,null],"p":[null,null],"close":"41.2","pivot":"41.64"}`,
	})
	require.Error(t, err)
	assert.Equal(t, "BHP", ev.StockCode)
	assert.Zero(t, ev.Close)
	assert.False(t, ev.HasPivot)
	assert.Zero(t, ev.Pivot)
	assert.Empty(t, ev.Rules)
}

// A CANSLIM setup marks only its failing trigger rules as waiting: near_high and
// rs_leader are the two triggers, and a passing or unknown trigger never waits.
func TestSignalEventProto_CANSLIMWaitingIsTheFailingTrigger(t *testing.T) {
	reg, ok := spec.Live(spec.StrategyCANSLIM)
	require.True(t, ok)
	h, err := spec.RulesHash(reg.Spec)
	require.NoError(t, err)
	require.Len(t, reg.Spec.Rules, 6, "the statuses below are the six CANSLIM rules")
	require.Equal(t, "near_high", reg.Spec.Rules[2].ID)
	require.Equal(t, "rs_leader", reg.Spec.Rules[3].ID)

	cases := []struct {
		name    string
		r       string
		waiting map[int]bool
	}{
		// near_high passes; only rs_leader fails, so only rs_leader waits.
		{"a failing rs_leader waits, a passing near_high does not", "PPPFPP", map[int]bool{2: false, 3: true}},
		// rs_leader is unknown: an unknown trigger is not what the stock waits for.
		{"an unknown rs_leader does not wait", "PPPUPP", map[int]bool{2: false, 3: false}},
	}
	for _, c := range cases {
		n := len(reg.Spec.Rules)
		ev, err := signalEventProto(shortsstore.StrategySignalEventRow{
			StockCode: "BHP", FromStatus: "watch", ToStatus: "setup", RulesHash: h,
			Evidence: signalEvidenceJSON(t, reg.Spec, c.r, 10.2, 9.5),
		})
		require.NoError(t, err, c.name)
		require.Len(t, ev.Rules, n, c.name)
		for i, want := range c.waiting {
			assert.Equal(t, want, ev.Rules[i].Waiting, "%s: rule %s", c.name, ev.Rules[i].RuleId)
		}
		for i, rr := range ev.Rules {
			if _, checked := c.waiting[i]; !checked {
				assert.False(t, rr.Waiting, "%s: non-trigger rule %s never waits", c.name, rr.RuleId)
			}
		}
	}
}
