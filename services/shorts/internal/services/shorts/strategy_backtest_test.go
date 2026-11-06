package shorts

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"testing"
	"time"

	"cloud.google.com/go/civil"
	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/backtest"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/features"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
	"github.com/castlemilk/shorted.com.au/services/shorts/internal/services/shorts/mocks"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"go.uber.org/mock/gomock"
)

// backtestFixtureLiveFrom is the fixture's live_from: the paper track starts here, and the
// in-sample backtest ends the session before.
var backtestFixtureLiveFrom = civil.Date{Year: 2026, Month: time.October, Day: 1}

// weekdays is every weekday from start to end, inclusive.
func weekdays(start, end civil.Date) []civil.Date {
	var out []civil.Date
	for d := start; !d.After(end); d = d.AddDays(1) {
		if wd := time.Date(d.Year, d.Month, d.Day, 0, 0, 0, 0, time.UTC).Weekday(); wd != time.Saturday && wd != time.Sunday {
			out = append(out, d)
		}
	}
	return out
}

// fixtureSeries is a run's stored series over the sessions: a steady rise with a dip, so the
// chained curve has a trough, benchmark and reference levels, and an exposure.
func fixtureSeries(dates []civil.Date) storedSeries {
	var s storedSeries
	for k, d := range dates {
		kk := float64(k)
		s.D = append(s.D, d.String())
		s.E = append(s.E, 100000*math.Pow(1.0002, kk)*(1+0.03*math.Sin(kk/40)))
		s.B = append(s.B, 5000*(1+0.0001*kk))
		s.R = append(s.R, 1000*(1+0.00012*kk))
		s.DD = append(s.DD, 0)
		s.X = append(s.X, 0.6)
	}
	return s
}

// fixturePaper is the paper track from live_from on, rebased to a different level so the
// chain has to scale it.
func fixturePaper(dates []civil.Date) []shortsstore.PaperEquityRow {
	var out []shortsstore.PaperEquityRow
	for m, d := range dates {
		if d.Before(backtestFixtureLiveFrom) {
			continue
		}
		mm := float64(m)
		bench := 5200 * (1 + 0.0001*mm)
		out = append(out, shortsstore.PaperEquityRow{
			AsOf: d.String(), Equity: 300000 * (1 + 0.0004*mm), Cash: 30000, Positions: 4, Benchmark: &bench,
		})
	}
	return out
}

// liveKeys are a strategy's live rules and recipe hashes, as the backtests key them.
func liveKeys(t *testing.T, id string) (string, string) {
	t.Helper()
	reg, ok := spec.Live(id)
	require.True(t, ok, id)
	rules, err := spec.RulesHash(reg.Spec)
	require.NoError(t, err)
	require.NotNil(t, reg.Recipe, id)
	recipe, err := spec.RecipeHash(*reg.Recipe)
	require.NoError(t, err)
	return rules, recipe
}

// fixtureRun is a published canonical run of a strategy's live key, with its series,
// summary and trades encoded the way the job writes them.
func fixtureRun(t *testing.T, id string, runID int64) (shortsstore.BacktestRunRow, []byte, []shortsstore.BacktestTradeRow) {
	t.Helper()
	rules, recipe := liveKeys(t, id)
	dates := weekdays(civil.Date{Year: 2019, Month: time.May, Day: 1}, civil.Date{Year: 2026, Month: time.November, Day: 5})
	series := fixtureSeries(dates)
	rawSeries, err := json.Marshal(series)
	require.NoError(t, err)
	cov := backtest.Coverage{Qualifying: backtest.CoverageMeasure{
		Measure: backtest.MeasureQualifying,
		Years:   []backtest.CoveragePeriod{{Period: "2019", Qualifying: 10, Priced: 7, Ratio: 0.7}},
	}}
	sum := storedSummary{
		State:        "computed",
		Coverage:     cov,
		Survivorship: backtest.Survivorship{Measurement: backtest.MeasurementMeasured, Direction: backtest.DirectionFlatters, Copy: "Prices are missing for companies that delisted."},
		Reference: backtest.WindowFigures{
			ID: "reference", Label: "Same-data reference",
			Start: civil.Date{Year: 2019, Month: time.May, Day: 1}, End: civil.Date{Year: 2026, Month: time.November, Day: 5},
		},
		Diff: backtest.NoPrevious(),
	}
	rawSummary, err := json.Marshal(sum)
	require.NoError(t, err)
	row := shortsstore.BacktestRunRow{
		ID: runID, RunKey: fmt.Sprintf("key-%d", runID), Kind: "publish", StrategyID: id,
		RulesHash: rules, RecipeHash: recipe, EngineVersion: engine.Version, Published: true,
		WindowStart: "2019-05-01", WindowEnd: "2026-11-05", Fundamentals: "strict",
		PricesThrough: "2026-11-05", ASICThrough: "2026-11-02", IndexThrough: "2026-11-05",
		InSampleUntil: backtestFixtureLiveFrom.AddDays(-1).String(),
		FinishedAt:    time.Date(2026, 11, 6, 3, 0, 0, 0, time.UTC),
		Summary:       rawSummary, Metrics: []byte("{}"), Diagnostics: []byte("{}"),
	}
	trades := []shortsstore.BacktestTradeRow{
		{Seq: 1, StockCode: "BHP", SignalDate: "2024-02-01", EntryDate: "2024-02-02", EntryPrice: 40, EntryScore: 80,
			ExitDate: "2024-03-01", ExitPrice: 44, ExitReason: "pivot_stop", SessionsHeld: 20, GrossReturnPct: 10, NetReturnPct: 9.5, Flags: []string{}},
		{Seq: 2, StockCode: "CBA", SignalDate: "2024-05-01", EntryDate: "2024-05-02", EntryPrice: 100, EntryScore: 70,
			ExitDate: "2024-06-01", ExitPrice: 95, ExitReason: "stop_loss", SessionsHeld: 20, GrossReturnPct: -5, NetReturnPct: -5.5, Flags: []string{}},
		// Exits after live_from: the paper track replaces it in the chained windows.
		{Seq: 3, StockCode: "WBC", SignalDate: "2026-09-20", EntryDate: "2026-09-21", EntryPrice: 30, EntryScore: 60,
			ExitDate: "2026-10-15", ExitPrice: 32, ExitReason: "time_stop", SessionsHeld: 18, GrossReturnPct: 6, NetReturnPct: 5.5, Flags: []string{}},
		{Seq: 4, StockCode: "RIO", SignalDate: "2026-10-20", EntryDate: "2026-10-21", EntryPrice: 90, EntryScore: 75,
			ExitReason: "open_at_end", Open: true, Flags: []string{}},
	}
	return row, rawSeries, trades
}

// backtestStoreFake is the backtest read side, keyed the way the Postgres store keys it.
type backtestStoreFake struct {
	published     map[string]shortsstore.BacktestRunRow
	notComputable map[string]shortsstore.BacktestRunRow
	running       map[string]time.Time
	runs          map[int64]shortsstore.BacktestRunRow
	series        map[int64][]byte
	trades        map[int64][]shortsstore.BacktestTradeRow
	paperEq       []shortsstore.PaperEquityRow
	paperTrades   []shortsstore.PaperTradeRow
	cash          []features.RatePoint
	// schemaErr makes every read answer a missing migration, as an unmigrated schema does.
	schemaErr bool
}

func newBacktestFake() *backtestStoreFake {
	return &backtestStoreFake{
		published:     map[string]shortsstore.BacktestRunRow{},
		notComputable: map[string]shortsstore.BacktestRunRow{},
		running:       map[string]time.Time{},
		runs:          map[int64]shortsstore.BacktestRunRow{},
		series:        map[int64][]byte{},
		trades:        map[int64][]shortsstore.BacktestTradeRow{},
	}
}

// publish seeds a computed run of the strategy's live key.
func (f *backtestStoreFake) publish(t *testing.T, id string, runID int64) {
	row, series, trades := fixtureRun(t, id, runID)
	f.published[id] = row
	f.runs[runID] = row
	f.series[runID] = series
	f.trades[runID] = trades
	f.paperEq = fixturePaper(weekdays(civil.Date{Year: 2026, Month: time.September, Day: 1}, civil.Date{Year: 2026, Month: time.November, Day: 5}))
	f.paperTrades = []shortsstore.PaperTradeRow{
		{StockCode: "RIO", SignalDate: "2026-10-20", EntryDate: "2026-10-21", EntryPrice: 90, ExitDate: "2026-10-30", ExitPrice: 95, ExitReason: "pivot_stop", Status: "closed"},
	}
	f.cash = []features.RatePoint{{Date: civil.Date{Year: 2019, Month: time.April, Day: 1}, Rate: 1.5}}
}

func (f *backtestStoreFake) ReadPublishedBacktest(_ context.Context, id, rules, recipe string) (shortsstore.BacktestRunRow, bool, error) {
	if f.schemaErr {
		return shortsstore.BacktestRunRow{}, false, shortsstore.ErrStrategyBacktestSchema
	}
	row, ok := f.published[id]
	if !ok || row.RulesHash != rules || row.RecipeHash != recipe {
		return shortsstore.BacktestRunRow{}, false, nil
	}
	return row, true, nil
}

func (f *backtestStoreFake) ReadCanonicalBacktest(_ context.Context, runID int64) (shortsstore.BacktestRunRow, bool, error) {
	if f.schemaErr {
		return shortsstore.BacktestRunRow{}, false, shortsstore.ErrStrategyBacktestSchema
	}
	row, ok := f.runs[runID]
	return row, ok, nil
}

func (f *backtestStoreFake) ReadNotComputableBacktest(_ context.Context, id, _, _ string) (shortsstore.BacktestRunRow, bool, error) {
	if f.schemaErr {
		return shortsstore.BacktestRunRow{}, false, shortsstore.ErrStrategyBacktestSchema
	}
	row, ok := f.notComputable[id]
	return row, ok, nil
}

func (f *backtestStoreFake) ReadRunningBacktest(_ context.Context, id, _, _ string) (time.Time, bool, error) {
	if f.schemaErr {
		return time.Time{}, false, shortsstore.ErrStrategyBacktestSchema
	}
	t, ok := f.running[id]
	return t, ok, nil
}

func (f *backtestStoreFake) ReadBacktestSeries(_ context.Context, runID int64) ([]byte, error) {
	if f.schemaErr {
		return nil, shortsstore.ErrStrategyBacktestSchema
	}
	return f.series[runID], nil
}

func (f *backtestStoreFake) ReadBacktestTrades(_ context.Context, runID int64) ([]shortsstore.BacktestTradeRow, error) {
	if f.schemaErr {
		return nil, shortsstore.ErrStrategyBacktestSchema
	}
	return f.trades[runID], nil
}

func (f *backtestStoreFake) ReadPaperEquity(_ context.Context, _, _ string) ([]shortsstore.PaperEquityRow, error) {
	if f.schemaErr {
		return nil, shortsstore.ErrStrategyBacktestSchema
	}
	return f.paperEq, nil
}

func (f *backtestStoreFake) ReadPaperTrades(_ context.Context, _, _ string) ([]shortsstore.PaperTradeRow, error) {
	if f.schemaErr {
		return nil, shortsstore.ErrStrategyBacktestSchema
	}
	return f.paperTrades, nil
}

func (f *backtestStoreFake) ReadCashRate(_ context.Context, _ civil.Date) ([]features.RatePoint, error) {
	return f.cash, nil
}

// backtestServer is a server whose backtest reads are the fake.
func backtestServer(t *testing.T, fake *backtestStoreFake) *ShortsServer {
	t.Helper()
	srv := newTestServer(t, newBacktestStoresMock(t))
	srv.strategyBacktests = fake
	return srv
}

// premiumUserContext is a signed-in caller whose Premium tier the interceptor resolved.
func resolvedPremiumContext() context.Context {
	return context.WithValue(context.Background(), userKey, &Claims{
		UserID:        "user_2",
		Email:         "premium@shorted.com.au",
		EmailVerified: true,
		Tier:          "premium",
		TierResolved:  true,
	})
}

// The access a private backtest read resolves: a resolved Premium tier is premium, and any
// other signed-in caller is free. An anonymous caller is refused before the access is read.
func TestPrivateAccessResolvesThePremiumTierForBacktests(t *testing.T) {
	access, uid, err := privateAccess(resolvedPremiumContext())
	require.NoError(t, err)
	assert.Equal(t, AccessPremium, access)
	assert.Equal(t, "user_2", uid)

	access, _, err = privateAccess(userContext("free"))
	require.NoError(t, err)
	assert.Equal(t, AccessFree, access)

	_, _, err = privateAccess(anonymousContext())
	assert.Equal(t, connect.CodeUnauthenticated, connect.CodeOf(err))
}

// anonymousContext is a request with no verified identity.
func anonymousContext() context.Context { return context.Background() }

// The chained curve is the in-sample backtest up to live_from, then the paper track rebased
// onto the last in-sample session (5.8): E(t) = E_bt(live_from-1) x paper(t)/paper(start).
func TestChainRebasesThePaperTrackOntoTheLastInSampleSession(t *testing.T) {
	dates := weekdays(civil.Date{Year: 2026, Month: time.September, Day: 1}, civil.Date{Year: 2026, Month: time.October, Day: 15})
	series := fixtureSeries(dates)
	paper := fixturePaper(dates)
	chain, err := buildChainedRun(series, backtestFixtureLiveFrom.AddDays(-1).String(), paper)
	require.NoError(t, err)
	require.NotNil(t, chain.paper)

	// The last in-sample session is the one before live_from.
	var i int
	for k, d := range dates {
		if d.Before(backtestFixtureLiveFrom) {
			i = k
		}
	}
	base := series.E[i]
	start := paper[0].Equity
	for _, d := range chain.days {
		if !d.recorded {
			continue
		}
		var m int
		for k, row := range paper {
			if row.AsOf == d.date.String() {
				m = k
			}
		}
		want := base * paper[m].Equity / start
		assert.InDelta(t, want, d.equity, 1e-6, d.date.String())
	}
	assert.True(t, chain.days[len(chain.days)-1].recorded, "the chained curve ends in the paper track")
	assert.Equal(t, backtestFixtureLiveFrom, chain.liveFrom)
}

// The Windows of a chained run: the Since windows end at the recorded tail, and the Live
// since freeze window is the paper track alone (5.8).
func TestWindowsChainTheSinceWindowsAndMeasureTheFreezeOnPaperAlone(t *testing.T) {
	dates := weekdays(civil.Date{Year: 2019, Month: time.May, Day: 1}, civil.Date{Year: 2026, Month: time.November, Day: 5})
	series := fixtureSeries(dates)
	paper := fixturePaper(dates)
	chain, err := buildChainedRun(series, backtestFixtureLiveFrom.AddDays(-1).String(), paper)
	require.NoError(t, err)
	figs, err := backtest.Windows(chain.bt, chain.paper, chain.liveFrom, nil)
	require.NoError(t, err)

	byID := map[string]backtest.WindowFigures{}
	for _, f := range figs {
		byID[f.ID] = f
	}
	since, ok := byID[backtest.WindowSinceMay2019]
	require.True(t, ok)
	assert.Equal(t, "2019-05-01", since.Start.String())
	assert.Equal(t, "2026-11-05", since.End.String(), "the since window runs to the latest recorded session")
	assert.Contains(t, since.Note, "recorded after")

	freeze, ok := byID[backtest.WindowLiveSinceFreeze]
	require.True(t, ok)
	assert.Equal(t, backtestFixtureLiveFrom.String(), freeze.Start.String(), "the freeze window starts at live_from")
	assert.Equal(t, "paper track only, recorded", freeze.Note)

	_, ok = byID[backtest.WindowSince2023]
	assert.True(t, ok, "the since-2023 window is measured")
	assert.Equal(t, "2023-01-03", byID[backtest.WindowSince2023].Start.String())
}

// Without a paper track the Since windows end at the freeze, and no freeze window is shown
// for sessions the backtest was not frozen against.
func TestWindowsWithoutAPaperTrackEndAtTheFreeze(t *testing.T) {
	dates := weekdays(civil.Date{Year: 2019, Month: time.May, Day: 1}, civil.Date{Year: 2026, Month: time.November, Day: 5})
	chain, err := buildChainedRun(fixtureSeries(dates), backtestFixtureLiveFrom.AddDays(-1).String(), nil)
	require.NoError(t, err)
	assert.Nil(t, chain.paper)
	figs, err := backtest.Windows(chain.bt, nil, chain.liveFrom, nil)
	require.NoError(t, err)
	for _, f := range figs {
		assert.NotEqual(t, backtest.WindowLiveSinceFreeze, f.ID)
		assert.True(t, f.End.Before(backtestFixtureLiveFrom), "%s ends before the freeze", f.ID)
	}
}

// Decimation (5.18): one point per ISO week (its last session), with the first, last and
// trough sessions kept, and never more than 500 points.
func TestDecimationKeepsFirstLastAndTroughAndCapsThePoints(t *testing.T) {
	dates := weekdays(civil.Date{Year: 2019, Month: time.May, Day: 1}, civil.Date{Year: 2026, Month: time.November, Day: 5})
	series := fixtureSeries(dates)
	chain, err := buildChainedRun(series, backtestFixtureLiveFrom.AddDays(-1).String(), fixturePaper(dates))
	require.NoError(t, err)
	_, trough := drawdowns(chain.days)
	require.GreaterOrEqual(t, trough, 0, "the fixture has a drawdown")

	idx := keptSessions(chain.days, trough)
	assert.LessOrEqual(t, len(idx), 500)
	assert.Contains(t, idx, 0, "the first session is kept")
	assert.Contains(t, idx, len(chain.days)-1, "the last session is kept")
	assert.Contains(t, idx, trough, "the trough session is kept")
	for p := 1; p < len(idx); p++ {
		assert.Less(t, idx[p-1], idx[p], "ascending and unique")
	}
	// Every other kept session is the last session of its ISO week.
	for _, k := range idx {
		if k == 0 || k == len(chain.days)-1 || k == trough {
			continue
		}
		assert.NotEqual(t, isoWeekKey(chain.days[k].date), isoWeekKey(chain.days[k+1].date), "%s is a week's last session", chain.days[k].date)
	}
}

// A long history is decimated under the cap, and the first, last and trough still survive the
// stride.
func TestDecimationStaysUnderTheCapOnALongHistory(t *testing.T) {
	dates := weekdays(civil.Date{Year: 2010, Month: time.January, Day: 1}, civil.Date{Year: 2026, Month: time.November, Day: 5})
	days := make([]chainDay, 0, len(dates))
	for k, d := range dates {
		days = append(days, chainDay{date: d, equity: 100 + float64(k%400)})
	}
	_, trough := drawdowns(days)
	idx := keptSessions(days, trough)
	assert.LessOrEqual(t, len(idx), weeklyPointCap)
	assert.Contains(t, idx, 0)
	assert.Contains(t, idx, len(days)-1)
	assert.Contains(t, idx, trough)
}

// CAGR shows only for a window of at least 365 calendar days, and Sharpe only for at least 126
// daily returns (5.8, 5.9).
func TestWindowThresholdsForCAGRAndSharpe(t *testing.T) {
	span := func(days int, n int) []chainDay {
		start := civil.Date{Year: 2025, Month: time.January, Day: 2}
		var out []chainDay
		for k := 0; k < n; k++ {
			out = append(out, chainDay{date: start.AddDays(k * days / (n - 1)), equity: 100 * (1 + 0.001*float64(k))})
		}
		return out
	}
	short := span(364, 130)
	long := span(366, 130)
	f := backtest.WindowOf("w", "w", backtest.Series{Basis: backtest.BasisTotal, Curve: curveOf(short)}, nil, "")
	assert.False(t, f.HasCAGR, "364 calendar days is not annualised")
	assert.True(t, f.NotAnnualised)
	g := backtest.WindowOf("w", "w", backtest.Series{Basis: backtest.BasisTotal, Curve: curveOf(long)}, nil, "")
	assert.True(t, g.HasCAGR, "366 calendar days is annualised")

	few := span(200, 125)
	h := backtest.WindowOf("w", "w", backtest.Series{Basis: backtest.BasisTotal, Curve: curveOf(few)}, nil, "")
	assert.False(t, h.Sharpe.Shown, "125 returns is below the 126 needed")
	k := backtest.WindowOf("w", "w", backtest.Series{Basis: backtest.BasisTotal, Curve: curveOf(span(200, 130))}, nil, "")
	assert.True(t, k.Sharpe.Shown, "130 returns is above the 126 needed")
}

// The replay line (5.13): compared only under the live fundamentals policy, and counted on
// (code, entry date, exit date).
func TestReplayAgreementCountsTradesSinceLiveFrom(t *testing.T) {
	run := []shortsstore.BacktestTradeRow{
		{StockCode: "RIO", EntryDate: "2026-10-21", ExitDate: "2026-10-30"},
		{StockCode: "BHP", EntryDate: "2026-10-22", ExitDate: "2026-11-01"},
		{StockCode: "WBC", EntryDate: "2026-09-21", ExitDate: "2026-10-15"}, // before live_from: not compared
	}
	paper := []shortsstore.PaperTradeRow{{StockCode: "RIO", EntryDate: "2026-10-21", ExitDate: "2026-10-30"}}
	assert.Equal(t, "Replay diverges: 1 of 2 trades agree", replayAgreement(run, paper, backtestFixtureLiveFrom, true, true))
	assert.Equal(t, "Replay not comparable: different fundamentals policy", replayAgreement(run, paper, backtestFixtureLiveFrom, true, false))
	paper = append(paper, shortsstore.PaperTradeRow{StockCode: "BHP", EntryDate: "2026-10-22", ExitDate: "2026-11-01"})
	assert.Equal(t, "Replay agrees: 2 of 2 trades", replayAgreement(run, paper, backtestFixtureLiveFrom, true, true))
}

// assertCode checks an error's connect code; noCode means the call must succeed.
func assertCode(t *testing.T, want connect.Code, err error) {
	t.Helper()
	if want == noCode {
		assert.NoError(t, err)
		return
	}
	assert.Equal(t, want, connect.CodeOf(err))
}

// The access table (8.6): a private rpc needs a signed-in caller, and a public one answers
// every caller the same bytes.
// noCode is the table's "served" answer: connect's codes start at 1, so zero is free.
const noCode connect.Code = 0

func TestBacktestAccessTable(t *testing.T) {
	fake := newBacktestFake()
	fake.publish(t, spec.StrategyCrowdedShortBreakout, 101)
	srv := backtestServer(t, fake)

	tests := []struct {
		name     string
		ctx      context.Context
		wantCode connect.Code
		private  bool
	}{
		{"private: anonymous is refused", anonymousContext(), connect.CodeUnauthenticated, true},
		{"private: free is served", userContext("free"), noCode, true},
		{"private: premium is served", resolvedPremiumContext(), noCode, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := srv.ListBacktestTrades(tc.ctx, connect.NewRequest(&shortsv1alpha1.ListBacktestTradesRequest{RunId: 101}))
			assertCode(t, tc.wantCode, err)
			_, err = srv.CompareStrategies(tc.ctx, connect.NewRequest(&shortsv1alpha1.CompareStrategiesRequest{
				Refs: []string{spec.StrategyCrowdedShortBreakout, spec.StrategyMinerviniTrend},
			}))
			assertCode(t, tc.wantCode, err)
		})
	}

	// The public reads answer the same bytes to every caller.
	req := func() *connect.Request[shortsv1alpha1.GetBacktestRunRequest] {
		return connect.NewRequest(&shortsv1alpha1.GetBacktestRunRequest{StrategyId: spec.StrategyCrowdedShortBreakout})
	}
	anon, err := srv.GetBacktestRun(anonymousContext(), req())
	require.NoError(t, err)
	free, err := srv.GetBacktestRun(userContext("free"), req())
	require.NoError(t, err)
	premium, err := srv.GetBacktestRun(resolvedPremiumContext(), req())
	require.NoError(t, err)
	assert.True(t, proto.Equal(anon.Msg, free.Msg), "free sees what anonymous sees")
	assert.True(t, proto.Equal(anon.Msg, premium.Msg), "premium sees what anonymous sees")
	assert.Equal(t, "computed", anon.Msg.Run.State)
	assert.Equal(t, int64(101), anon.Msg.Run.Identity.RunId, "the published run is served anonymously")

	ev1, err := srv.ListStrategyEvidence(anonymousContext(), connect.NewRequest(&shortsv1alpha1.ListStrategyEvidenceRequest{}))
	require.NoError(t, err)
	ev2, err := srv.ListStrategyEvidence(resolvedPremiumContext(), connect.NewRequest(&shortsv1alpha1.ListStrategyEvidenceRequest{}))
	require.NoError(t, err)
	assert.True(t, proto.Equal(ev1.Msg, ev2.Msg), "the evidence list is caller-invariant")
}

// Another user's or a variant run is NotFound, and no variant appears in any backtest reader
// (2.1 item 5). The fake holds only canonical publish runs, as the store's queries do.
func TestBacktestReadersNeverReturnVariants(t *testing.T) {
	fake := newBacktestFake()
	fake.publish(t, spec.StrategyCrowdedShortBreakout, 101)
	srv := backtestServer(t, fake)
	ctx := resolvedPremiumContext()

	_, err := srv.GetBacktestRun(anonymousContext(), connect.NewRequest(&shortsv1alpha1.GetBacktestRunRequest{
		StrategyId: spec.StrategyCrowdedShortBreakout, RunId: 999,
	}))
	assert.Equal(t, connect.CodeNotFound, connect.CodeOf(err), "a variant or foreign run id is not found")

	_, err = srv.ListBacktestTrades(ctx, connect.NewRequest(&shortsv1alpha1.ListBacktestTradesRequest{RunId: 999}))
	assert.Equal(t, connect.CodeNotFound, connect.CodeOf(err))

	_, err = srv.CompareStrategies(ctx, connect.NewRequest(&shortsv1alpha1.CompareStrategiesRequest{
		Refs: []string{"variant:" + strings.Repeat("a", 8), spec.StrategyMinerviniTrend},
	}))
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err), "a variant reference is refused")

	ev, err := srv.ListStrategyEvidence(anonymousContext(), connect.NewRequest(&shortsv1alpha1.ListStrategyEvidenceRequest{}))
	require.NoError(t, err)
	for _, e := range ev.Msg.Strategies {
		if e.Version != nil {
			assert.Equal(t, "canonical", e.Version.Kind, e.StrategyId)
		}
	}
}

// A schema without the backtest or paper tables reads as run_required, never an error (1.7).
func TestDegradedSchemaAnswersRunRequired(t *testing.T) {
	fake := newBacktestFake()
	fake.schemaErr = true
	srv := backtestServer(t, fake)

	run, err := srv.GetBacktestRun(anonymousContext(), connect.NewRequest(&shortsv1alpha1.GetBacktestRunRequest{StrategyId: spec.StrategyZangerBreakout}))
	require.NoError(t, err)
	assert.Equal(t, "run_required", run.Msg.Run.State)
	assert.Nil(t, run.Msg.Run.Identity)

	ev, err := srv.ListStrategyEvidence(anonymousContext(), connect.NewRequest(&shortsv1alpha1.ListStrategyEvidenceRequest{}))
	require.NoError(t, err)
	require.NotEmpty(t, ev.Msg.Strategies)
	for _, e := range ev.Msg.Strategies {
		assert.Contains(t, []string{"run_required", "not_computable"}, e.State, e.StrategyId)
		assert.NotNil(t, e.Paper, "the paper summary is present, empty")
		assert.True(t, e.Paper.TooShort)
	}

	_, err = srv.ListBacktestTrades(userContext("free"), connect.NewRequest(&shortsv1alpha1.ListBacktestTradesRequest{RunId: 1}))
	assert.Equal(t, connect.CodeNotFound, connect.CodeOf(err), "no run to list")
}

// A strategy with no published run is in a well-defined state, and a strategy whose recipe is
// not computable reads not_computable with its measured label (1.7, 5.15).
func TestStatesOfAStrategyWithoutAPublishedRun(t *testing.T) {
	fake := newBacktestFake()
	rules, recipe := liveKeys(t, spec.StrategyZangerBreakout)
	fake.notComputable[spec.StrategyZangerBreakout] = shortsstore.BacktestRunRow{
		ID: 7, StrategyID: spec.StrategyZangerBreakout, RulesHash: rules, RecipeHash: recipe,
		ComputableFrom: "2025-08-31", FiscalLabel: "FY2024",
		Summary: []byte(`{"state":"not_computable","share":0.42,"threshold":0.5}`),
	}
	fake.running[spec.StrategyCANSLIM] = time.Date(2026, 11, 6, 14, 2, 0, 0, time.UTC)
	srv := backtestServer(t, fake)

	nc, err := srv.GetBacktestRun(anonymousContext(), connect.NewRequest(&shortsv1alpha1.GetBacktestRunRequest{StrategyId: spec.StrategyZangerBreakout}))
	require.NoError(t, err)
	assert.Equal(t, "not_computable", nc.Msg.Run.State)
	assert.Equal(t, "FY2024", nc.Msg.Run.FiscalLabel)
	assert.Equal(t, "2025-08-31", nc.Msg.Run.ComputableFrom)
	assert.True(t, nc.Msg.Run.HasComputableShare)
	assert.InDelta(t, 42, nc.Msg.Run.ComputableSharePct, 1e-9)

	running, err := srv.GetBacktestRun(anonymousContext(), connect.NewRequest(&shortsv1alpha1.GetBacktestRunRequest{StrategyId: spec.StrategyCANSLIM}))
	require.NoError(t, err)
	assert.Equal(t, "running", running.Msg.Run.State)
	assert.Equal(t, "2026-11-06T14:02:00Z", running.Msg.Run.RunningSince)

	req, err := srv.GetBacktestRun(anonymousContext(), connect.NewRequest(&shortsv1alpha1.GetBacktestRunRequest{StrategyId: spec.StrategyMinerviniTrend}))
	require.NoError(t, err)
	assert.Equal(t, "run_required", req.Msg.Run.State)

	ev, err := srv.ListStrategyEvidence(anonymousContext(), connect.NewRequest(&shortsv1alpha1.ListStrategyEvidenceRequest{}))
	require.NoError(t, err)
	for _, e := range ev.Msg.Strategies {
		if e.StrategyId == spec.StrategyZangerBreakout {
			assert.Equal(t, "not_computable", e.State)
			assert.Equal(t, "FY2024", e.FiscalLabel)
		}
	}
}

// The computed run's payload: the series is decimated, the windows, the annual and monthly
// tables and the coverage are built, and the replay agreement names the trades since live_from.
func TestComputedRunServesItsTablesAndSeries(t *testing.T) {
	fake := newBacktestFake()
	fake.publish(t, spec.StrategyCrowdedShortBreakout, 101)
	srv := backtestServer(t, fake)

	resp, err := srv.GetBacktestRun(anonymousContext(), connect.NewRequest(&shortsv1alpha1.GetBacktestRunRequest{StrategyId: spec.StrategyCrowdedShortBreakout}))
	require.NoError(t, err)
	run := resp.Msg.Run
	assert.Equal(t, "computed", run.State)
	assert.True(t, run.RulesMatchLive)
	assert.True(t, run.EngineMatchesLive)
	assert.LessOrEqual(t, len(run.Series), 500)
	assert.NotEmpty(t, run.Series)
	assert.Equal(t, "weekly", run.SeriesResolution)

	labels := map[string]bool{}
	for _, w := range run.Windows {
		labels[w.Window] = true
	}
	assert.True(t, labels[backtest.WindowSinceMay2019])
	assert.True(t, labels[backtest.WindowLiveSinceFreeze], "the freeze window is measured on paper")

	require.NotEmpty(t, run.Annual)
	assert.Equal(t, "partial", run.Annual[0].State, "the first year is partial from its first session")
	assert.Equal(t, "not_elapsed", run.Annual[len(run.Annual)-1].State, "the current year is not elapsed")
	require.NotEmpty(t, run.Monthly)
	assert.Equal(t, "MTD", run.Monthly[len(run.Monthly)-1].Label)

	require.Len(t, run.CoverageByYear, 1)
	assert.Equal(t, int32(2019), run.CoverageByYear[0].Year)
	assert.InDelta(t, 70, run.CoverageByYear[0].QualifyingPct, 1e-9)
	// The run's one trade entered since live_from (RIO) is open in the run and closed on paper, so
	// it does not agree; the WBC trade entered before the freeze and is not compared.
	assert.Equal(t, "Replay diverges: 0 of 1 trades agree", run.ReplayAgreement)
	assert.Equal(t, int32(3), run.TradeSummary.Closed, "three closed trades in the run")
	assert.Equal(t, int32(1), run.TradeSummary.OpenAtEnd)
}

// The trades of a run page with a token, filter by stock and exit reason, and refuse a page
// over 200.
func TestListBacktestTradesPagesAndFilters(t *testing.T) {
	fake := newBacktestFake()
	fake.publish(t, spec.StrategyCrowdedShortBreakout, 101)
	srv := backtestServer(t, fake)
	ctx := userContext("free")

	page1, err := srv.ListBacktestTrades(ctx, connect.NewRequest(&shortsv1alpha1.ListBacktestTradesRequest{RunId: 101, PageSize: 2}))
	require.NoError(t, err)
	assert.Len(t, page1.Msg.Trades, 2)
	assert.Equal(t, int32(4), page1.Msg.Total)
	assert.NotEmpty(t, page1.Msg.NextPageToken)

	page2, err := srv.ListBacktestTrades(ctx, connect.NewRequest(&shortsv1alpha1.ListBacktestTradesRequest{RunId: 101, PageSize: 2, PageToken: page1.Msg.NextPageToken}))
	require.NoError(t, err)
	assert.Len(t, page2.Msg.Trades, 2)
	assert.Empty(t, page2.Msg.NextPageToken, "the last page has no token")

	byStock, err := srv.ListBacktestTrades(ctx, connect.NewRequest(&shortsv1alpha1.ListBacktestTradesRequest{RunId: 101, StockCode: "cba"}))
	require.NoError(t, err)
	require.Len(t, byStock.Msg.Trades, 1)
	assert.Equal(t, "CBA", byStock.Msg.Trades[0].StockCode)

	byReason, err := srv.ListBacktestTrades(ctx, connect.NewRequest(&shortsv1alpha1.ListBacktestTradesRequest{RunId: 101, ExitReason: "pivot_stop"}))
	require.NoError(t, err)
	assert.Equal(t, int32(1), byReason.Msg.Total)

	_, err = srv.ListBacktestTrades(ctx, connect.NewRequest(&shortsv1alpha1.ListBacktestTradesRequest{RunId: 101, PageSize: 201}))
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
	_, err = srv.ListBacktestTrades(ctx, connect.NewRequest(&shortsv1alpha1.ListBacktestTradesRequest{RunId: 101, PageToken: "x"}))
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
}

// The request validation of the backtest rpcs.
func TestBacktestRequestValidation(t *testing.T) {
	fake := newBacktestFake()
	fake.publish(t, spec.StrategyCrowdedShortBreakout, 101)
	srv := backtestServer(t, fake)

	_, err := srv.GetBacktestRun(anonymousContext(), connect.NewRequest(&shortsv1alpha1.GetBacktestRunRequest{StrategyId: "nope"}))
	assert.Equal(t, connect.CodeNotFound, connect.CodeOf(err))
	_, err = srv.GetBacktestRun(anonymousContext(), connect.NewRequest(&shortsv1alpha1.GetBacktestRunRequest{StrategyId: spec.StrategyCrowdedShortBreakout, Resolution: "daily"}))
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err), "daily is refused: its series would exceed the budget")

	ctx := userContext("free")
	one := []string{spec.StrategyCrowdedShortBreakout}
	_, err = srv.CompareStrategies(ctx, connect.NewRequest(&shortsv1alpha1.CompareStrategiesRequest{Refs: one}))
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err), "one strategy is not a comparison")
	_, err = srv.CompareStrategies(ctx, connect.NewRequest(&shortsv1alpha1.CompareStrategiesRequest{Refs: []string{
		spec.StrategyCrowdedShortBreakout, spec.StrategyMinerviniTrend, spec.StrategyZangerBreakout, spec.StrategyCANSLIM,
	}}))
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err), "four strategies is too many")
	_, err = srv.CompareStrategies(ctx, connect.NewRequest(&shortsv1alpha1.CompareStrategiesRequest{Refs: []string{
		spec.StrategyCrowdedShortBreakout, spec.StrategyCrowdedShortBreakout,
	}}))
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err), "a strategy named twice")
	_, err = srv.CompareStrategies(ctx, connect.NewRequest(&shortsv1alpha1.CompareStrategiesRequest{Refs: []string{
		spec.StrategyCrowdedShortBreakout, "no-such-strategy",
	}}))
	assert.Equal(t, connect.CodeNotFound, connect.CodeOf(err))
}

// Two computed strategies compare over the sessions both hold, with curves rebased to 100,000
// and a correlation between their daily returns.
func TestCompareStrategiesOverTheCommonWindow(t *testing.T) {
	fake := newBacktestFake()
	fake.publish(t, spec.StrategyCrowdedShortBreakout, 101)
	// Minervini's own published run: the same fixture under its key, with its own run id.
	row, series, trades := fixtureRun(t, spec.StrategyMinerviniTrend, 102)
	fake.published[spec.StrategyMinerviniTrend] = row
	fake.runs[102] = row
	fake.series[102] = series
	fake.trades[102] = trades
	srv := backtestServer(t, fake)

	resp, err := srv.CompareStrategies(resolvedPremiumContext(), connect.NewRequest(&shortsv1alpha1.CompareStrategiesRequest{
		Refs: []string{spec.StrategyCrowdedShortBreakout, spec.StrategyMinerviniTrend},
	}))
	require.NoError(t, err)
	assert.Equal(t, "common", resp.Msg.WindowId)
	require.Len(t, resp.Msg.Entries, 2)
	for _, e := range resp.Msg.Entries {
		assert.Equal(t, "computed", e.State)
		require.NotNil(t, e.Window)
		require.NotEmpty(t, e.Series)
		assert.InDelta(t, 100000, e.Series[0].Equity, 1e-6, "rebased to 100,000 on the first session")
	}
	require.Len(t, resp.Msg.Correlations, 1)
	assert.True(t, resp.Msg.Correlations[0].HasCorrelation)
}

// A test store's read of the backtest tables must not reach the mock store: the server's
// ShortsStore is a mock with no expectations, so an unexpected call fails the test.
func newBacktestStoresMock(t *testing.T) ShortsStore {
	t.Helper()
	m := mocks.NewMockShortsStore(gomock.NewController(t))
	// The evidence's today counts read the candidate universe. This test has none, so the
	// read fails and the counts are left out, as they are for any unreadable universe.
	m.EXPECT().ListStrategyCandidates(gomock.Any()).Return(nil, errors.New("no candidate universe in this test")).AnyTimes()
	return m
}

// The compare's correlation of two identical return series is one, and a flat series has none.
func TestCorrelateOfIdenticalAndFlatSeries(t *testing.T) {
	start := civil.Date{Year: 2025, Month: time.January, Day: 2}
	var a, b, flat map[civil.Date]float64
	a, b, flat = map[civil.Date]float64{}, map[civil.Date]float64{}, map[civil.Date]float64{}
	for k := 1; k < 40; k++ {
		d := start.AddDays(k)
		a[d] = math.Sin(float64(k))
		b[d] = math.Sin(float64(k))
		flat[d] = 0
	}
	c, n, ok := correlate(a, b)
	assert.True(t, ok)
	assert.Equal(t, 39, n)
	assert.InDelta(t, 1, c, 1e-9)
	_, _, ok = correlate(a, flat)
	assert.False(t, ok, "a flat series has no correlation")
}

// The backtest's stored JSON decodes into the package's own types, including the civil dates
// the summary carries, so a run written by the job is read back exactly.
func TestStoredSummaryRoundTripsThroughTheBacktestTypes(t *testing.T) {
	cutoff := civil.Date{Year: 2026, Month: time.October, Day: 1}
	sum := storedSummary{
		State:     "computed",
		Reference: backtest.WindowFigures{ID: "reference", Start: cutoff, End: cutoff.AddDays(30)},
		Diff:      backtest.DiffNote{State: "changed", RewrittenCount: 3, PreviousCutOff: cutoff, HasCAGRShift: true, CAGRShiftPP: 0.3},
		Share:     ptrF(0.42),
		Coverage:  backtest.Coverage{Qualifying: backtest.CoverageMeasure{Years: []backtest.CoveragePeriod{{Period: "2019", Qualifying: 4, Priced: 3, Ratio: 0.75}}}},
	}
	raw, err := json.Marshal(sum)
	require.NoError(t, err)
	var back storedSummary
	require.NoError(t, json.Unmarshal(raw, &back))
	assert.Equal(t, 3, back.Diff.RewrittenCount)
	assert.Equal(t, cutoff, back.Diff.PreviousCutOff)
	require.NotNil(t, back.Share)
	assert.InDelta(t, 0.42, *back.Share, 1e-9)
	assert.Equal(t, 0.75, back.Coverage.Qualifying.Years[0].Ratio)
	assert.Contains(t, diffNoteOf(back.Diff), "3 codes' price rows rewritten")
}

func ptrF(v float64) *float64 { return &v }

// Trade summary (5.10): counts, win rate over closed trades, exits by reason and open trades.
func TestTradeSummaryOfARun(t *testing.T) {
	_, _, trades := fixtureRun(t, spec.StrategyCrowdedShortBreakout, 1)
	s := tradeSummaryOf(trades)
	assert.Equal(t, int32(3), s.Closed, "three closed trades")
	assert.Equal(t, int32(1), s.OpenAtEnd)
	assert.True(t, s.HasWinRate)
	assert.InDelta(t, 100*2.0/3.0, s.WinRatePct, 1e-4)
	assert.Equal(t, int32(1), s.ExitsByReason["open_at_end"])
	assert.InDelta(t, 9.5, s.BestPct, 1e-9)
	assert.InDelta(t, -5.5, s.WorstPct, 1e-9)
}

// The paper summary (5.9): too short under 63 sessions or 10 closed trades.
func TestPaperSummaryIsTooShortBelowTheThresholds(t *testing.T) {
	rows := fixturePaper(weekdays(civil.Date{Year: 2026, Month: time.October, Day: 1}, civil.Date{Year: 2026, Month: time.November, Day: 5}))
	p := paperSummaryOf(backtestFixtureLiveFrom.String(), rows, []shortsstore.PaperTradeRow{{Status: "closed"}})
	assert.True(t, p.TooShort)
	assert.True(t, p.HasReturn)
	assert.Equal(t, int32(1), p.ClosedTrades)
	assert.Equal(t, backtestFixtureLiveFrom.String(), p.Since)
}
