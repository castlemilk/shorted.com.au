package shorts

import (
	"context"
	"encoding/json"
	"errors"
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
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/backtest"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/features"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/services/shorts/mocks"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// truncateFrom drops the fake run's stored series before from: a run whose own history starts later.
func truncateFrom(t *testing.T, fake *backtestStoreFake, runID int64, from civil.Date) {
	t.Helper()
	var series storedSeries
	require.NoError(t, json.Unmarshal(fake.series[runID], &series))
	keep := 0
	for keep < len(series.D) {
		d, err := civil.ParseDate(series.D[keep])
		require.NoError(t, err)
		if !d.Before(from) {
			break
		}
		keep++
	}
	series.D, series.E, series.B, series.R, series.DD, series.X = series.D[keep:], series.E[keep:], series.B[keep:], series.R[keep:], series.DD[keep:], series.X[keep:]
	raw, err := json.Marshal(series)
	require.NoError(t, err)
	fake.series[runID] = raw
}

// Item 2: a run trade that exits after the paper track's last session is not compared, but its still-open paper
// counterpart is the same trade, so it is not counted as a paper-only trade.
func TestReplayCountsAnOpenPaperCounterpartOfALaggingRunTrade(t *testing.T) {
	runEnd := civil.Date{Year: 2026, Month: 11, Day: 5}
	paperEnd := civil.Date{Year: 2026, Month: 11, Day: 4}
	run := []shortsstore.BacktestTradeRow{
		{StockCode: "BHP", EntryDate: "2026-10-22", ExitDate: "2026-11-06"},
		{StockCode: "RIO", EntryDate: "2026-10-21", ExitDate: "2026-10-30"},
	}
	paper := []shortsstore.PaperTradeRow{
		{StockCode: "BHP", EntryDate: "2026-10-22", Status: "open"},
		{StockCode: "RIO", EntryDate: "2026-10-21", ExitDate: "2026-10-30", Status: "closed"},
	}
	assert.Equal(t, "Replay agrees: 1 of 1 trades", replayAgreement(run, paper, backtestFixtureLiveFrom, true, runEnd, paperEnd, true),
		"the lagging BHP trade is the open paper BHP trade, not a paper-only trade")
}

// Item 3: the identity names the cash rate only when the cash series covers the run and pays a rate.
func TestRiskFreeNamesTheCashRateOnlyWhenTheSeriesCoversIt(t *testing.T) {
	cases := []struct {
		name string
		cash []features.RatePoint
		want string
	}{
		{"covered", []features.RatePoint{{Date: civil.Date{Year: 2019, Month: time.April, Day: 1}, Rate: 1.5}}, "RBA cash rate"},
		{"all zero", []features.RatePoint{{Date: civil.Date{Year: 2019, Month: time.April, Day: 1}, Rate: 0}}, "none"},
		{"starts after the run", []features.RatePoint{{Date: civil.Date{Year: 2026, Month: time.January, Day: 1}, Rate: 4.35}}, "none"},
		{"missing", nil, "none"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fake := newBacktestFake()
			fake.publish(t, spec.StrategyCrowdedShortBreakout, 101)
			fake.cash = tc.cash
			srv := backtestServer(t, fake)
			resp, err := srv.GetBacktestRun(anonymousContext(), connect.NewRequest(&shortsv1alpha1.GetBacktestRunRequest{StrategyId: spec.StrategyCrowdedShortBreakout}))
			require.NoError(t, err)
			assert.Equal(t, tc.want, resp.Msg.Run.Identity.RiskFree)
		})
	}
}

// Item 3: a failed cash read fails the request and is not cached: the next request reads again and succeeds.
func TestFailedCashReadIsNotCached(t *testing.T) {
	fake := newBacktestFake()
	fake.publish(t, spec.StrategyCrowdedShortBreakout, 101)
	fake.cashErr = true
	srv := backtestServer(t, fake)
	req := func() *connect.Request[shortsv1alpha1.GetBacktestRunRequest] {
		return connect.NewRequest(&shortsv1alpha1.GetBacktestRunRequest{StrategyId: spec.StrategyCrowdedShortBreakout})
	}
	_, err := srv.GetBacktestRun(anonymousContext(), req())
	require.Error(t, err, "a Sharpe ratio against zero is not served")
	fake.cashErr = false
	resp, err := srv.GetBacktestRun(anonymousContext(), req())
	require.NoError(t, err, "the failure was not cached")
	assert.Equal(t, "RBA cash rate", resp.Msg.Run.Identity.RiskFree)
}

// Item 4: each compared strategy starts at 100,000 on the common window's first session, which here is 2023-01-03,
// not at the first session of either run.
func TestCompareRebasesEachStrategyToOneHundredThousandOnTheCommonWindow(t *testing.T) {
	fake := newBacktestFake()
	fake.publish(t, spec.StrategyCrowdedShortBreakout, 101)
	fake.publish(t, spec.StrategyMinerviniTrend, 102)
	truncateFrom(t, fake, 102, civil.Date{Year: 2023, Month: time.January, Day: 3})
	srv := backtestServer(t, fake)
	resp, err := srv.CompareStrategies(resolvedPremiumContext(), connect.NewRequest(&shortsv1alpha1.CompareStrategiesRequest{
		Refs: []string{spec.StrategyCrowdedShortBreakout, spec.StrategyMinerviniTrend},
	}))
	require.NoError(t, err)
	assert.Equal(t, "2023-01-03", resp.Msg.WindowFrom)
	for _, e := range resp.Msg.Entries {
		require.NotEmpty(t, e.Series, e.StrategyId)
		assert.Equal(t, "2023-01-03", e.Series[0].Date, e.StrategyId)
		assert.InDelta(t, 100000, e.Series[0].Equity, 1e-6, "%s starts at 100,000", e.StrategyId)
	}
}

// Item 5: every public backtest read answers the same bytes to every caller kind on a cold server, and a
// published run is in the answer. The caller's uid is not written into a published answer.
func TestPublishedBacktestReadsAreCallerInvariant(t *testing.T) {
	build := func() *ShortsServer {
		fake := newBacktestFake()
		fake.publish(t, spec.StrategyCrowdedShortBreakout, 101)
		return backtestServer(t, fake)
	}
	reads := []struct {
		name string
		call func(srv *ShortsServer, ctx context.Context) proto.Message
	}{
		{"GetBacktestRun", func(srv *ShortsServer, ctx context.Context) proto.Message {
			resp, err := srv.GetBacktestRun(ctx, connect.NewRequest(&shortsv1alpha1.GetBacktestRunRequest{StrategyId: spec.StrategyCrowdedShortBreakout}))
			require.NoError(t, err)
			return resp.Msg
		}},
		{"ListStrategyEvidence", func(srv *ShortsServer, ctx context.Context) proto.Message {
			resp, err := srv.ListStrategyEvidence(ctx, connect.NewRequest(&shortsv1alpha1.ListStrategyEvidenceRequest{}))
			require.NoError(t, err)
			return resp.Msg
		}},
	}
	kinds := vdHTTPCallers()
	kinds = append(kinds, struct {
		name string
		ctx  func() context.Context
	}{"mcp viewer", func() context.Context { return vdMCP("mcp-user") }})
	for _, read := range reads {
		want := vdBytes(t, read.call(build(), anonymousContext()))
		require.Contains(t, string(want), "2026-10-01", read.name)
		for _, k := range kinds {
			got := vdBytes(t, read.call(build(), k.ctx()))
			assert.Equal(t, want, got, "%s for %s", read.name, k.name)
		}
	}
}

// Item 7: an ASIC-reported strategy serves one measure, consistent across the coverage rows, the annual rows and the
// survivorship: the all-reported measure, measurable from 2025 and not before.
func TestAsicReportedRunServesOneMeasureConsistently(t *testing.T) {
	fake := newBacktestFake()
	fake.publishWith(t, spec.StrategyMinerviniTrend, 201, backtest.MeasurementASICOnly)
	srv := backtestServer(t, fake)
	resp, err := srv.GetBacktestRun(anonymousContext(), connect.NewRequest(&shortsv1alpha1.GetBacktestRunRequest{StrategyId: spec.StrategyMinerviniTrend}))
	require.NoError(t, err)
	run := resp.Msg.Run
	require.Equal(t, "partial", run.Survivorship.Measurement)
	require.NotEmpty(t, run.Coverage)
	for _, c := range run.Coverage {
		assert.False(t, c.Measurable, "year %d: the qualifying measure is not this strategy's, so it is not served", c.Year)
		assert.Zero(t, c.CoveragePct, "year %d", c.Year)
		assert.Equal(t, c.Year >= 2025, c.AllReportedMeasurable, "year %d: all-reported is measurable from 2025", c.Year)
	}
	for _, m := range run.CoverageMonthly {
		assert.False(t, m.Measurable, m.Month)
	}
	for _, a := range run.Annual {
		if a.Year < 2025 {
			assert.Equal(t, "not_measurable", a.CoverageMeasure, "annual %d", a.Year)
		} else {
			assert.Equal(t, "all_reported", a.CoverageMeasure, "annual %d", a.Year)
		}
	}
}

// Item 8: the evidence's version carries live_from from the version table.
func TestEvidenceVersionCarriesLiveFrom(t *testing.T) {
	srv := backtestServer(t, newBacktestFake())
	ev, err := srv.ListStrategyEvidence(anonymousContext(), connect.NewRequest(&shortsv1alpha1.ListStrategyEvidenceRequest{}))
	require.NoError(t, err)
	v := findEvidence(t, ev.Msg.Strategies, spec.StrategyCrowdedShortBreakout).Version
	require.NotNil(t, v)
	assert.Equal(t, "2026-10-01", v.LiveFrom)
	assert.Equal(t, "live", v.Status)
}

// Item 9: the run carries all five sensitivity runs of 5.12, in the table's order, with one fragile row.
func TestSensitivityCarriesAllFiveRunsWithOneFragile(t *testing.T) {
	fake := newBacktestFake()
	fake.publish(t, spec.StrategyCrowdedShortBreakout, 101)
	srv := backtestServer(t, fake)
	resp, err := srv.GetBacktestRun(anonymousContext(), connect.NewRequest(&shortsv1alpha1.GetBacktestRunRequest{StrategyId: spec.StrategyCrowdedShortBreakout}))
	require.NoError(t, err)
	var ids []string
	var fragile []string
	for _, s := range resp.Msg.Run.Sensitivity {
		ids = append(ids, s.Id)
		if s.Fragile {
			fragile = append(fragile, s.Id+":"+s.FragileChip)
		}
	}
	assert.Equal(t, backtest.SensitivityIDs, ids)
	assert.Equal(t, []string{backtest.SensCostsX2 + ":Fragile to costs"}, fragile)
}

// Item 10: the identity carries the input, output and run keys the disclosure states.
func TestIdentityCarriesTheFingerprints(t *testing.T) {
	fake := newBacktestFake()
	fake.publish(t, spec.StrategyCrowdedShortBreakout, 101)
	srv := backtestServer(t, fake)
	resp, err := srv.GetBacktestRun(anonymousContext(), connect.NewRequest(&shortsv1alpha1.GetBacktestRunRequest{StrategyId: spec.StrategyCrowdedShortBreakout}))
	require.NoError(t, err)
	id := resp.Msg.Run.Identity
	assert.Len(t, id.InputHash, 64)
	assert.Len(t, id.OutputHash, 64)
	assert.NotEmpty(t, id.RunKey)
}

// Item 16: a live window with no paper track answers an empty series with its resolution set, and says why.
func TestLiveWindowWithoutATrackIsAnEmptyStateNotAnError(t *testing.T) {
	fake := newBacktestFake()
	fake.publish(t, spec.StrategyCrowdedShortBreakout, 101)
	fake.paperRules = ""
	srv := backtestServer(t, fake)
	resp, err := srv.GetBacktestRun(anonymousContext(), connect.NewRequest(&shortsv1alpha1.GetBacktestRunRequest{StrategyId: spec.StrategyCrowdedShortBreakout, Window: "live"}))
	require.NoError(t, err)
	assert.Equal(t, "none", resp.Msg.Run.SeriesResolution)
	assert.Empty(t, resp.Msg.Run.Series)
	for _, w := range resp.Msg.Run.Windows {
		assert.NotEqual(t, windowLive, w.Window, "no live window is measured without a track")
	}
	found := false
	for _, n := range resp.Msg.Run.DataNotes {
		if strings.Contains(n, "The live window has no sessions") {
			found = true
		}
	}
	assert.True(t, found, "the empty state is named in the data notes")
}

// Item 17: a track that starts after the run's own history names the gap between them; a track that starts on
// live_from has none.
func TestTheGapBetweenTheRunAndTheTrackIsNamed(t *testing.T) {
	fake := newBacktestFake()
	fake.publish(t, spec.StrategyCrowdedShortBreakout, 101)
	truncateSeries(t, fake, 101, civil.Date{Year: 2026, Month: time.September, Day: 15})
	srv := backtestServer(t, fake)
	resp, err := srv.GetBacktestRun(anonymousContext(), connect.NewRequest(&shortsv1alpha1.GetBacktestRunRequest{StrategyId: spec.StrategyCrowdedShortBreakout}))
	require.NoError(t, err)
	for _, w := range resp.Msg.Run.Windows {
		if w.Window == windowSince2019 {
			// The track is the fixture's, which starts on live_from: the sessions from the run's end to the day before
			// the track are the named gap.
			assert.Equal(t, "in-sample to 2026-09-15, recorded from 2026-10-01; no figures from 2026-09-16 to 2026-09-30", w.Note)
		}
	}

	onFreeze := newBacktestFake()
	onFreeze.publish(t, spec.StrategyCrowdedShortBreakout, 101)
	dates := weekdays(civil.Date{Year: 2026, Month: time.September, Day: 1}, civil.Date{Year: 2026, Month: time.November, Day: 5})
	onFreeze.paperEq = paperFrom(dates, backtestFixtureLiveFrom, func(m int) float64 { return 5000 }, engine.Version)
	srv2 := backtestServer(t, onFreeze)
	resp2, err := srv2.GetBacktestRun(anonymousContext(), connect.NewRequest(&shortsv1alpha1.GetBacktestRunRequest{StrategyId: spec.StrategyCrowdedShortBreakout}))
	require.NoError(t, err)
	for _, w := range resp2.Msg.Run.Windows {
		if w.Window == windowSince2019 {
			assert.NotContains(t, w.Note, "no figures", "a track on live_from has no gap")
		}
	}
}

// Item 18: an evidence answer whose today counts are missing is served but not cached, so the next request reads
// again; a complete answer is cached.
func TestEvidenceWithMissingTodayCountsIsNotCached(t *testing.T) {
	fake := newBacktestFake()
	fake.publish(t, spec.StrategyCrowdedShortBreakout, 101)
	// A store whose candidate universe cannot be read: the today counts are then missing.
	base := mocks.NewMockShortsStore(gomock.NewController(t))
	base.EXPECT().ListStrategyCandidates(gomock.Any()).Return(nil, errors.New("candidates unavailable")).AnyTimes()
	base.EXPECT().GetMarketRegime(gomock.Any(), gomock.Any()).Return(engine.Regime{}, nil).AnyTimes()
	m := &versionedStore{MockShortsStore: base, rows: fixtureVersionRows(t)}
	srv := newTestServer(t, m)
	srv.strategyBacktests = fake
	req := connect.NewRequest(&shortsv1alpha1.ListStrategyEvidenceRequest{})
	_, err := srv.ListStrategyEvidence(anonymousContext(), req)
	require.NoError(t, err)
	reads := fake.publishedReads
	_, err = srv.ListStrategyEvidence(anonymousContext(), req)
	require.NoError(t, err)
	assert.Greater(t, fake.publishedReads, reads, "an incomplete answer is read again")
}
