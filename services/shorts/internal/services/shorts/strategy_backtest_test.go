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
	"go.uber.org/mock/gomock"
	"google.golang.org/protobuf/encoding/protojson"
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
)

// backtestFixtureLiveFrom is the fixture's live_from: the paper track starts here, and the in-sample
// backtest ends the session before.
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

// fixtureSeries is a run's stored series, shaped as the job writes it: parallel arrays over the sessions,
// with the drawdown fraction of the equity and the reference level on every session (the job writes the
// reference from the records it now fills).
func fixtureSeries(dates []civil.Date) storedSeries {
	var s storedSeries
	var peak float64
	for k, d := range dates {
		kk := float64(k)
		e := 100000 * math.Pow(1.0002, kk) * (1 + 0.03*math.Sin(kk/40))
		if e > peak {
			peak = e
		}
		s.D = append(s.D, d.String())
		s.E = append(s.E, e)
		s.B = append(s.B, 5000*(1+0.0001*kk))
		s.R = append(s.R, 1000*(1+0.00012*kk))
		s.DD = append(s.DD, e/peak-1)
		s.X = append(s.X, 0.6)
	}
	return s
}

// fixturePaper is the paper track from live_from on, rebased to a different level so the chain has to
// scale it.
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
			EngineVersion: engine.Version,
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

// fixtureSensitivities are the five sensitivity runs of a canonical run (5.12), in the table's order. Only the
// costs run is fragile.
func fixtureSensitivities() backtest.Sensitivities {
	fig := func(cagr, excess, dd float64) backtest.Figures {
		return backtest.Figures{CAGR: cagr, HasCAGR: true, Excess: excess, HasExcess: true, MaxDrawdown: dd}
	}
	return backtest.Sensitivities{
		Base: fig(0.12, 0.05, -0.31),
		Runs: []backtest.Sensitivity{
			{ID: backtest.SensCostsX2, Label: "Costs doubled", Applies: true, Figures: fig(0.09, -0.01, -0.33), Fragile: backtest.FragileCosts},
			{ID: backtest.SensASICLagPlus2, Label: "ASIC publication two sessions later", Applies: true, Figures: fig(0.11, 0.03, -0.32)},
			{ID: backtest.SensDelistingZero, Label: "Delisted positions exit at zero", Applies: true, Figures: fig(0.11, 0.04, -0.32)},
			{ID: backtest.SensEntryPlus1, Label: "Entry one session later", Applies: true, Figures: fig(0.10, 0.02, -0.30)},
			{ID: backtest.SensFlatMockup, Label: "Mockup costs (flat 10 + 5 bps per side) flatter small-cap breakouts", Applies: true, Figures: fig(0.11, 0.03, -0.31)},
		},
	}
}

// fixtureRun is a publishable canonical run of a strategy's live key, with its series, summary and trades
// encoded the way the job writes them. measurement is the summary's survivorship measurement.
func fixtureRun(t *testing.T, id string, runID int64, measurement string) (shortsstore.BacktestRunRow, []byte, []shortsstore.BacktestTradeRow) {
	t.Helper()
	rules, recipe := liveKeys(t, id)
	dates := weekdays(civil.Date{Year: 2019, Month: time.May, Day: 1}, civil.Date{Year: 2026, Month: time.November, Day: 5})
	series := fixtureSeries(dates)
	rawSeries, err := json.Marshal(series)
	require.NoError(t, err)
	// Realistic two-measure coverage: a year and a month per period, both measures, as the job stores them.
	cov := backtest.Coverage{}
	for y := 2019; y <= 2026; y++ {
		cov.Qualifying.Years = append(cov.Qualifying.Years, backtest.CoveragePeriod{Period: fmt.Sprintf("%04d", y), Qualifying: 10, Priced: 7, Ratio: 0.7})
		cov.AllReported.Years = append(cov.AllReported.Years, backtest.CoveragePeriod{Period: fmt.Sprintf("%04d", y), Qualifying: 40, Priced: 36, Ratio: 0.9})
	}
	for _, d := range dates {
		if d.Day != 1 && d.Month == time.May && d.Year == 2019 {
			continue
		}
		key := fmt.Sprintf("%04d-%02d", d.Year, d.Month)
		cov.Qualifying.Months = append(cov.Qualifying.Months, backtest.CoveragePeriod{Period: key, Qualifying: 12, Priced: 9, Ratio: 0.75})
		cov.AllReported.Months = append(cov.AllReported.Months, backtest.CoveragePeriod{Period: key, Qualifying: 48, Priced: 43, Ratio: 0.9})
	}
	sum := storedSummary{
		State:    "computed",
		Coverage: cov,
		Survivorship: backtest.Survivorship{
			Measurement: measurement, Direction: backtest.DirectionFlatters,
			Copy: "Prices are missing for companies that delisted before about 2025.",
		},
		Reference: backtest.WindowFigures{
			ID: "reference", Label: "Same-data reference", HasTotalReturn: true, TotalReturn: 0.4,
			HasCAGR: true, CAGR: 0.05, Start: civil.Date{Year: 2019, Month: time.May, Day: 1}, End: civil.Date{Year: 2026, Month: time.November, Day: 5},
		},
		DataQuality: backtest.DataQuality{DelistingExits: 2, CorporateActionExit: 1, FallbackClose: 3, CancelledEntries: map[string]int{"liquidity": 4}},
		Diff:        backtest.NoPrevious(),
	}
	if measurement == backtest.MeasurementASICOnly {
		sum.Survivorship.Caveat = "Coverage is measured on ASIC-reported names only; the gap cannot be measured for companies that were never reported short."
	}
	// The five sensitivity runs of 5.12, with one fragile (a sign flip of the excess CAGR under costs doubled).
	sum.Sensitivity = fixtureSensitivities()
	rawSummary, err := json.Marshal(sum)
	require.NoError(t, err)
	row := shortsstore.BacktestRunRow{
		ID: runID, RunKey: fmt.Sprintf("key-%d", runID), Kind: "publish", StrategyID: id,
		InputHash: strings.Repeat("1", 64), OutputHash: strings.Repeat("2", 64), BuildRevision: "fixture",
		RulesHash: rules, RecipeHash: recipe, EngineVersion: engine.Version, Published: true,
		WindowStart: "2019-05-01", WindowEnd: "2026-11-05", Fundamentals: "strict",
		PricesThrough: "2026-11-05", ASICThrough: "2026-11-02", IndexThrough: "2026-11-05",
		InSampleUntil: backtestFixtureLiveFrom.AddDays(-1).String(),
		FinishedAt:    time.Date(2026, 11, 6, 3, 0, 0, 0, time.UTC),
		Summary:       rawSummary,
	}
	trades := []shortsstore.BacktestTradeRow{
		{Seq: 1, StockCode: "BHP", SignalDate: "2024-02-01", EntryDate: "2024-02-02", EntryPrice: 40, EntryScore: 80.44,
			ExitDate: "2024-03-01", ExitPrice: 44, ExitReason: "pivot_stop", SessionsHeld: 20, GrossReturnPct: 10, NetReturnPct: 9.5, Flags: []string{}},
		{Seq: 2, StockCode: "CBA", SignalDate: "2024-05-01", EntryDate: "2024-05-02", EntryPrice: 100, EntryScore: 70,
			ExitDate: "2024-06-01", ExitPrice: 95, ExitReason: "stop_loss", SessionsHeld: 20, GrossReturnPct: -5, NetReturnPct: -5.5, Flags: []string{}},
		{Seq: 3, StockCode: "WBC", SignalDate: "2026-09-20", EntryDate: "2026-09-21", EntryPrice: 30, EntryScore: 60,
			ExitDate: "2026-10-15", ExitPrice: 32, ExitReason: "time_stop", SessionsHeld: 18, GrossReturnPct: 6, NetReturnPct: 5.5, Flags: []string{}},
		{Seq: 4, StockCode: "RIO", SignalDate: "2026-10-20", EntryDate: "2026-10-21", EntryPrice: 90, EntryScore: 75,
			ExitReason: "open_at_end", Open: true, Flags: []string{}},
	}
	return row, rawSeries, trades
}

// backtestStoreFake is the backtest read side. It keeps the rows the store keeps and applies the store's
// own visibility: a run is served by id only when visible (a publishable canonical run), and its trades
// are served only with it. Reads are counted, so the cache tests can see a hit.
type backtestStoreFake struct {
	runs          map[int64]shortsstore.BacktestRunRow
	visible       map[int64]bool
	published     map[string]shortsstore.BacktestRunRow
	notComputable map[string]shortsstore.BacktestRunRow
	running       map[string]time.Time
	series        map[int64][]byte
	trades        map[int64][]shortsstore.BacktestTradeRow
	paperEq       []shortsstore.PaperEquityRow
	paperTrades   []shortsstore.PaperTradeRow
	// paperRules is the rules hash the paper track belongs to: other strategies have no track in the fake.
	paperRules  string
	cash        []features.RatePoint
	seriesReads int
	// failNextSeries makes the next series read fail, to prove an error is not cached.
	failNextSeries bool
	// schemaErr makes every read answer a missing migration, as an unmigrated schema does.
	schemaErr bool
	// publishedReads counts the published-run reads: one per evidence strategy and request.
	publishedReads int
	// cashErr makes the cash-rate read fail, so a request that needs it fails rather than caching a Sharpe ratio
	// computed without one.
	cashErr bool
}

func newBacktestFake() *backtestStoreFake {
	return &backtestStoreFake{
		runs:          map[int64]shortsstore.BacktestRunRow{},
		visible:       map[int64]bool{},
		published:     map[string]shortsstore.BacktestRunRow{},
		notComputable: map[string]shortsstore.BacktestRunRow{},
		running:       map[string]time.Time{},
		series:        map[int64][]byte{},
		trades:        map[int64][]shortsstore.BacktestTradeRow{},
		cash:          []features.RatePoint{{Date: civil.Date{Year: 2019, Month: time.April, Day: 1}, Rate: 1.5}},
	}
}

// publish seeds a published canonical run of the strategy's live key.
func (f *backtestStoreFake) publish(t *testing.T, id string, runID int64) {
	f.publishWith(t, id, runID, backtest.MeasurementMeasured)
}

// publishWith seeds a published run with a survivorship measurement.
func (f *backtestStoreFake) publishWith(t *testing.T, id string, runID int64, measurement string) {
	row, series, trades := fixtureRun(t, id, runID, measurement)
	f.published[id] = row
	f.runs[runID] = row
	f.visible[runID] = true
	f.series[runID] = series
	f.trades[runID] = trades
	f.paperEq = fixturePaper(weekdays(civil.Date{Year: 2026, Month: time.September, Day: 1}, civil.Date{Year: 2026, Month: time.November, Day: 5}))
	f.paperRules = row.RulesHash
	f.paperTrades = []shortsstore.PaperTradeRow{
		{StockCode: "RIO", SignalDate: "2026-10-20", EntryDate: "2026-10-21", EntryPrice: 90, ExitDate: "2026-10-30", ExitPrice: 95, ExitReason: "pivot_stop", Status: "closed"},
	}
}

// addRun seeds a row that is not served as a published run: a gate-refused publish, a variant, a verify
// rerun. visible states whether the store serves it by id.
func (f *backtestStoreFake) addRun(row shortsstore.BacktestRunRow, visible bool) {
	f.runs[row.ID] = row
	f.visible[row.ID] = visible
}

func (f *backtestStoreFake) schemaOr(ok bool) error {
	if f.schemaErr {
		return shortsstore.ErrStrategyBacktestSchema
	}
	return nil
}

func (f *backtestStoreFake) ReadPublishedBacktest(_ context.Context, id, rules, recipe string) (shortsstore.BacktestRunRow, bool, error) {
	f.publishedReads++
	if err := f.schemaOr(true); err != nil {
		return shortsstore.BacktestRunRow{}, false, err
	}
	row, ok := f.published[id]
	if !ok || row.RulesHash != rules || row.RecipeHash != recipe {
		return shortsstore.BacktestRunRow{}, false, nil
	}
	return row, true, nil
}

func (f *backtestStoreFake) ReadCanonicalBacktest(_ context.Context, runID int64) (shortsstore.BacktestRunRow, bool, error) {
	if err := f.schemaOr(true); err != nil {
		return shortsstore.BacktestRunRow{}, false, err
	}
	row, ok := f.runs[runID]
	if !ok || !f.visible[runID] {
		return shortsstore.BacktestRunRow{}, false, nil
	}
	return row, true, nil
}

func (f *backtestStoreFake) ReadNotComputableBacktest(_ context.Context, id, _, _ string) (shortsstore.BacktestRunRow, bool, error) {
	if err := f.schemaOr(true); err != nil {
		return shortsstore.BacktestRunRow{}, false, err
	}
	row, ok := f.notComputable[id]
	return row, ok, nil
}

func (f *backtestStoreFake) ReadRunningBacktest(_ context.Context, id, _, _ string) (time.Time, bool, error) {
	if err := f.schemaOr(true); err != nil {
		return time.Time{}, false, err
	}
	t, ok := f.running[id]
	return t, ok, nil
}

func (f *backtestStoreFake) ReadBacktestSeries(_ context.Context, runID int64) ([]byte, error) {
	if err := f.schemaOr(true); err != nil {
		return nil, err
	}
	f.seriesReads++
	if f.failNextSeries {
		f.failNextSeries = false
		return nil, errors.New("a transient read failure")
	}
	return f.series[runID], nil
}

// visibleTrades is a run's trades when the store serves the run.
func (f *backtestStoreFake) visibleTrades(runID int64) []shortsstore.BacktestTradeRow {
	if !f.visible[runID] {
		return nil
	}
	return f.trades[runID]
}

func (f *backtestStoreFake) ReadBacktestTrades(_ context.Context, runID int64) ([]shortsstore.BacktestTradeRow, error) {
	if err := f.schemaOr(true); err != nil {
		return nil, err
	}
	return f.visibleTrades(runID), nil
}

func (f *backtestStoreFake) matches(t shortsstore.BacktestTradeRow, flt shortsstore.BacktestTradeFilter) bool {
	return (flt.StockCode == "" || t.StockCode == flt.StockCode) && (flt.ExitReason == "" || t.ExitReason == flt.ExitReason)
}

func (f *backtestStoreFake) CountBacktestTrades(_ context.Context, runID int64, flt shortsstore.BacktestTradeFilter) (int, error) {
	if err := f.schemaOr(true); err != nil {
		return 0, err
	}
	n := 0
	for _, t := range f.visibleTrades(runID) {
		if f.matches(t, flt) {
			n++
		}
	}
	return n, nil
}

func (f *backtestStoreFake) ReadBacktestTradesPage(_ context.Context, runID int64, flt shortsstore.BacktestTradeFilter, after, limit int) ([]shortsstore.BacktestTradeRow, error) {
	if err := f.schemaOr(true); err != nil {
		return nil, err
	}
	var out []shortsstore.BacktestTradeRow
	for _, t := range f.visibleTrades(runID) {
		if t.Seq > after && f.matches(t, flt) {
			out = append(out, t)
			if len(out) == limit {
				break
			}
		}
	}
	return out, nil
}

func (f *backtestStoreFake) ReadPaperEquity(_ context.Context, rules, _ string) ([]shortsstore.PaperEquityRow, error) {
	if err := f.schemaOr(true); err != nil {
		return nil, err
	}
	if rules != f.paperRules {
		return nil, nil
	}
	return f.paperEq, nil
}

func (f *backtestStoreFake) ReadPaperTrades(_ context.Context, rules, _ string) ([]shortsstore.PaperTradeRow, error) {
	if err := f.schemaOr(true); err != nil {
		return nil, err
	}
	if rules != f.paperRules {
		return nil, nil
	}
	return f.paperTrades, nil
}

func (f *backtestStoreFake) ReadCashRate(_ context.Context, _ civil.Date) ([]features.RatePoint, error) {
	if f.cashErr {
		return nil, errors.New("the cash series is unreadable")
	}
	return f.cash, nil
}

// versionedStore is the test store: the mock, with the canonical version table the version RPCs and the live
// version read from. Its rows are the table's rows; a strategy with no row falls back to the registry.
type versionedStore struct {
	*mocks.MockShortsStore
	rows []shortsstore.CanonicalRuleVersion
}

// ReadCanonicalRuleVersions is the table.
func (v *versionedStore) ReadCanonicalRuleVersions(context.Context) ([]shortsstore.CanonicalRuleVersion, error) {
	return v.rows, nil
}

// fixtureVersionRows is the table of the fixture: Crowded-Short's live version went live on the day the rules
// froze (live_from 2026-10-01, the freeze the fixture's run is in-sample to the day before).
func fixtureVersionRows(t *testing.T) []shortsstore.CanonicalRuleVersion {
	t.Helper()
	rules, _ := liveKeys(t, spec.StrategyCrowdedShortBreakout)
	return []shortsstore.CanonicalRuleVersion{
		{RulesHash: rules, StrategyID: spec.StrategyCrowdedShortBreakout, Label: "v1", Status: "live", LiveFrom: "2026-10-01"},
	}
}

// backtestServer is a server whose backtest reads are the fake, with the fixture's version table. Its candidate
// universe is empty and its market regime is neutral, so the today counts are complete.
func backtestServer(t *testing.T, fake *backtestStoreFake) *ShortsServer {
	t.Helper()
	return backtestServerWithRows(t, fake, fixtureVersionRows(t))
}

// backtestServerWithRows is backtestServer with a given version table.
func backtestServerWithRows(t *testing.T, fake *backtestStoreFake, rows []shortsstore.CanonicalRuleVersion) *ShortsServer {
	t.Helper()
	srv := newTestServer(t, newBacktestStoresMock(t, rows))
	srv.strategyBacktests = fake
	return srv
}

// newBacktestStoresMock is the store the server reads: the mock with an empty candidate universe and a neutral
// regime, so the today counts are computed, plus the given version table.
func newBacktestStoresMock(t *testing.T, rows []shortsstore.CanonicalRuleVersion) ShortsStore {
	t.Helper()
	m := mocks.NewMockShortsStore(gomock.NewController(t))
	m.EXPECT().ListStrategyCandidates(gomock.Any()).Return([]engine.Candidate{}, nil).AnyTimes()
	m.EXPECT().GetMarketRegime(gomock.Any(), gomock.Any()).Return(engine.Regime{}, nil).AnyTimes()
	return &versionedStore{MockShortsStore: m, rows: rows}
}

// anonymousContext is a request with no verified identity.
func anonymousContext() context.Context { return context.Background() }

// resolvedPremiumContext is a signed-in caller whose Premium tier the interceptor resolved.
func resolvedPremiumContext() context.Context {
	return context.WithValue(context.Background(), userKey, &Claims{
		UserID:        "user_2",
		Email:         "premium@shorted.com.au",
		EmailVerified: true,
		Tier:          "premium",
		TierResolved:  true,
	})
}

// noCode is the access table's "served" answer: connect's codes start at 1, so zero is free.
const noCode connect.Code = 0

// assertCode checks an error's connect code; noCode means the call must succeed.
func assertCode(t *testing.T, want connect.Code, err error) {
	t.Helper()
	if want == noCode {
		assert.NoError(t, err)
		return
	}
	assert.Equal(t, want, connect.CodeOf(err))
}

// The chained curve is the in-sample backtest up to live_from, then the paper track rebased onto the last
// in-sample session (5.8): E(t) = E_bt(live_from-1) x paper(t)/paper(start).
func TestChainRebasesThePaperTrackOntoTheLastInSampleSession(t *testing.T) {
	dates := weekdays(civil.Date{Year: 2026, Month: time.September, Day: 1}, civil.Date{Year: 2026, Month: time.October, Day: 15})
	series := fixtureSeries(dates)
	paper := fixturePaper(dates)
	chain, err := buildChainedRun(series, backtestFixtureLiveFrom.AddDays(-1).String(), paper)
	require.NoError(t, err)
	require.NotNil(t, chain.paper)

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

// The Since windows chain the paper track; the Live since freeze window is the paper track alone (5.8).
func TestWindowsChainTheSinceWindowsAndMeasureTheFreezeOnPaperAlone(t *testing.T) {
	dates := weekdays(civil.Date{Year: 2019, Month: time.May, Day: 1}, civil.Date{Year: 2026, Month: time.November, Day: 5})
	chain, err := buildChainedRun(fixtureSeries(dates), backtestFixtureLiveFrom.AddDays(-1).String(), fixturePaper(dates))
	require.NoError(t, err)
	figs, err := backtest.Windows(chain.bt, chain.paper, chain.liveFrom, nil)
	require.NoError(t, err)

	byID := map[string]backtest.WindowFigures{}
	for _, f := range figs {
		byID[f.ID] = f
	}
	since := byID[backtest.WindowSinceMay2019]
	assert.Equal(t, "2019-05-01", since.Start.String())
	assert.Equal(t, "2026-11-05", since.End.String())
	assert.Contains(t, since.Note, "recorded after")
	freeze, ok := byID[backtest.WindowLiveSinceFreeze]
	require.True(t, ok)
	assert.Equal(t, backtestFixtureLiveFrom.String(), freeze.Start.String())
	assert.Equal(t, "paper track only, recorded", freeze.Note)
	assert.Equal(t, "2023-01-03", byID[backtest.WindowSince2023].Start.String())
}

// Last 12 months opens on the last session on or before latest minus 365 days, so the window keeps its CAGR
// (it is at least 365 calendar days) on a Monday and after a holiday (15).
func TestLastTwelveMonthsOpensOnTheLastSessionOnOrBeforeAYearAgo(t *testing.T) {
	dates := weekdays(civil.Date{Year: 2019, Month: time.May, Day: 1}, civil.Date{Year: 2026, Month: time.November, Day: 5})
	chain, err := buildChainedRun(fixtureSeries(dates), backtestFixtureLiveFrom.AddDays(-1).String(), fixturePaper(dates))
	require.NoError(t, err)
	figs, err := backtest.Windows(chain.bt, chain.paper, chain.liveFrom, nil)
	require.NoError(t, err)
	var last12 backtest.WindowFigures
	for _, f := range figs {
		if f.ID == backtest.WindowLast12Months {
			last12 = f
		}
	}
	latest := civil.Date{Year: 2026, Month: time.November, Day: 5}
	assert.False(t, last12.Start.After(latest.AddDays(-365)), "the window opens on or before a year back")
	assert.True(t, last12.HasCAGR, "the window keeps its annualised CAGR")
}

// Decimation (5.18): one point per ISO week (its last session), with the must-keep sessions kept, and never
// more than 500 points.
func TestDecimationKeepsTheMustKeepSessionsAndCapsThePoints(t *testing.T) {
	dates := weekdays(civil.Date{Year: 2019, Month: time.May, Day: 1}, civil.Date{Year: 2026, Month: time.November, Day: 5})
	chain, err := buildChainedRun(fixtureSeries(dates), backtestFixtureLiveFrom.AddDays(-1).String(), fixturePaper(dates))
	require.NoError(t, err)
	_, trough := drawdowns(chain.days)
	require.GreaterOrEqual(t, trough, 0)
	idx := keptSessions(chain.days, []int{trough})
	assert.LessOrEqual(t, len(idx), 500)
	assert.Contains(t, idx, 0)
	assert.Contains(t, idx, len(chain.days)-1)
	assert.Contains(t, idx, trough)
	for p := 1; p < len(idx); p++ {
		assert.Less(t, idx[p-1], idx[p], "ascending and unique")
	}
}

// On a long history the stride path keeps the cap, always, and keeps every must-keep session: 1,000 weeks
// used to give 502 points.
func TestDecimationStaysUnderTheCapOnALongHistory(t *testing.T) {
	dates := weekdays(civil.Date{Year: 2006, Month: time.January, Day: 2}, civil.Date{Year: 2026, Month: time.November, Day: 5})
	days := make([]chainDay, 0, len(dates))
	for k, d := range dates {
		days = append(days, chainDay{date: d, equity: 100 + float64(k%400)})
	}
	_, trough := drawdowns(days)
	must := []int{trough, 1, 2, len(days) / 2, len(days) / 3, len(days) / 4, len(days) / 5, len(days) / 6, len(days) / 7}
	idx := keptSessions(days, must)
	require.LessOrEqual(t, len(idx), weeklyPointCap, "at most the cap, always")
	for _, m := range append(must, 0, len(days)-1) {
		assert.Contains(t, idx, m, "the must-keep session %d is kept", m)
	}
}

// CAGR shows only for a window of at least 365 calendar days, and Sharpe only for at least 126 daily
// returns (5.8, 5.9).
func TestWindowThresholdsForCAGRAndSharpe(t *testing.T) {
	span := func(days int, n int) []chainDay {
		start := civil.Date{Year: 2025, Month: time.January, Day: 2}
		var out []chainDay
		for k := 0; k < n; k++ {
			out = append(out, chainDay{date: start.AddDays(k * days / (n - 1)), equity: 100 * (1 + 0.001*float64(k))})
		}
		return out
	}
	short := backtest.WindowOf("w", "w", backtest.Series{Basis: backtest.BasisTotal, Curve: curveOf(span(364, 130))}, nil, "")
	assert.False(t, short.HasCAGR, "364 calendar days is not annualised")
	assert.True(t, short.NotAnnualised)
	long := backtest.WindowOf("w", "w", backtest.Series{Basis: backtest.BasisTotal, Curve: curveOf(span(366, 130))}, nil, "")
	assert.True(t, long.HasCAGR)
	assert.False(t, backtest.WindowOf("w", "w", backtest.Series{Basis: backtest.BasisTotal, Curve: curveOf(span(200, 125))}, nil, "").Sharpe.Shown)
	assert.True(t, backtest.WindowOf("w", "w", backtest.Series{Basis: backtest.BasisTotal, Curve: curveOf(span(200, 130))}, nil, "").Sharpe.Shown)
}

// The replay (5.13): a run trade and a paper trade agree on code, entry and exit. The count is over the union
// of both sides, so a paper trade the run does not have is a disagreement.
func TestReplayAgreementAgreesOnAMatchedTrade(t *testing.T) {
	run := []shortsstore.BacktestTradeRow{{StockCode: "BHP", EntryDate: "2026-10-22", ExitDate: "2026-11-01"}}
	paper := []shortsstore.PaperTradeRow{{StockCode: "BHP", EntryDate: "2026-10-22", ExitDate: "2026-11-01", Status: "closed"}}
	got := replayAgreement(run, paper, backtestFixtureLiveFrom, true, civil.Date{Year: 2026, Month: 11, Day: 5}, civil.Date{Year: 2026, Month: 11, Day: 5}, true)
	assert.Equal(t, "Replay agrees: 1 of 1 trades", got)
}

func TestReplayAgreementCountsAPaperOnlyTradeAsADisagreement(t *testing.T) {
	run := []shortsstore.BacktestTradeRow{{StockCode: "BHP", EntryDate: "2026-10-22", ExitDate: "2026-11-01"}}
	paper := []shortsstore.PaperTradeRow{
		{StockCode: "BHP", EntryDate: "2026-10-22", ExitDate: "2026-11-01", Status: "closed"},
		{StockCode: "WBC", EntryDate: "2026-10-23", ExitDate: "2026-11-02", Status: "closed"},
	}
	got := replayAgreement(run, paper, backtestFixtureLiveFrom, true, civil.Date{Year: 2026, Month: 11, Day: 5}, civil.Date{Year: 2026, Month: 11, Day: 5}, true)
	assert.Equal(t, "Replay diverges: 1 of 2 trades agree", got, "the paper-only WBC trade is in the count")
}

func TestReplayAgreementAgreesAnOpenRunTradeWithAnOpenOrLaterPaperExit(t *testing.T) {
	runEnd := civil.Date{Year: 2026, Month: 11, Day: 5}
	run := []shortsstore.BacktestTradeRow{{StockCode: "RIO", EntryDate: "2026-10-21", Open: true}}
	stillOpen := []shortsstore.PaperTradeRow{{StockCode: "RIO", EntryDate: "2026-10-21", Status: "open"}}
	assert.Equal(t, "Replay agrees: 1 of 1 trades", replayAgreement(run, stillOpen, backtestFixtureLiveFrom, true, runEnd, runEnd, true))
	exitsLater := []shortsstore.PaperTradeRow{{StockCode: "RIO", EntryDate: "2026-10-21", ExitDate: "2026-11-09", Status: "closed"}}
	assert.Equal(t, "Replay agrees: 1 of 1 trades", replayAgreement(run, exitsLater, backtestFixtureLiveFrom, true, runEnd, civil.Date{Year: 2026, Month: 11, Day: 10}, true),
		"a paper exit after the run's window end agrees with a run trade open at its end")
}

func TestReplayAgreementLeavesOutTradesThePaperTrackHasNotReached(t *testing.T) {
	runEnd := civil.Date{Year: 2026, Month: 11, Day: 5}
	paperEnd := civil.Date{Year: 2026, Month: 11, Day: 4}
	// BHP exits on 6 Nov, after the paper track's last session (4 Nov): not comparable yet, so it is not
	// counted. RIO is in range and the paper track agrees with it.
	run := []shortsstore.BacktestTradeRow{
		{StockCode: "BHP", EntryDate: "2026-10-22", ExitDate: "2026-11-06"},
		{StockCode: "RIO", EntryDate: "2026-10-21", ExitDate: "2026-10-30"},
	}
	paper := []shortsstore.PaperTradeRow{{StockCode: "RIO", EntryDate: "2026-10-21", ExitDate: "2026-10-30", Status: "closed"}}
	assert.Equal(t, "Replay agrees: 1 of 1 trades", replayAgreement(run, paper, backtestFixtureLiveFrom, true, runEnd, paperEnd, true))
	assert.Equal(t, "No trades entered between 2026-10-01 and 2026-11-04 to compare",
		replayAgreement(run[:1], nil, backtestFixtureLiveFrom, true, runEnd, paperEnd, true),
		"nothing comparable in range states that there is nothing to compare")
}

func TestReplayAgreementIsNotComparedForAnotherPolicy(t *testing.T) {
	assert.Equal(t, "Replay not comparable: different fundamentals policy",
		replayAgreement(nil, nil, backtestFixtureLiveFrom, true, civil.Date{}, civil.Date{}, false))
}

// The access table (8.6): a private rpc needs a signed-in caller, and a public one answers every caller the
// same bytes.
func TestBacktestAccessTable(t *testing.T) {
	fake := newBacktestFake()
	fake.publish(t, spec.StrategyCrowdedShortBreakout, 101)
	srv := backtestServer(t, fake)

	tests := []struct {
		name     string
		ctx      context.Context
		wantCode connect.Code
	}{
		{"private: anonymous is refused", anonymousContext(), connect.CodeUnauthenticated},
		{"private: free is served", userContext("free"), noCode},
		{"private: premium is served", resolvedPremiumContext(), noCode},
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
	assert.Equal(t, "published", anon.Msg.Run.State)
	assert.Equal(t, int64(101), anon.Msg.Run.Identity.RunId)

	ev1, err := srv.ListStrategyEvidence(anonymousContext(), connect.NewRequest(&shortsv1alpha1.ListStrategyEvidenceRequest{}))
	require.NoError(t, err)
	ev2, err := srv.ListStrategyEvidence(resolvedPremiumContext(), connect.NewRequest(&shortsv1alpha1.ListStrategyEvidenceRequest{}))
	require.NoError(t, err)
	assert.True(t, proto.Equal(ev1.Msg, ev2.Msg), "the evidence list is caller-invariant")
}

// The store's visibility, emulated: a gate-refused publish, a variant's run and a verify rerun are not found
// by id, and their trades are not served; another strategy's run is not found under this strategy.
func TestBacktestReadersServeOnlyPublishableCanonicalRuns(t *testing.T) {
	fake := newBacktestFake()
	fake.publish(t, spec.StrategyCrowdedShortBreakout, 101)
	gated, _, _ := fixtureRun(t, spec.StrategyCrowdedShortBreakout, 102, backtest.MeasurementMeasured)
	fake.addRun(gated, false) // gate-refused: succeeded publish, never published
	variant, _, _ := fixtureRun(t, spec.StrategyCrowdedShortBreakout, 103, backtest.MeasurementMeasured)
	fake.addRun(variant, false)
	fake.trades[102] = []shortsstore.BacktestTradeRow{{Seq: 1, StockCode: "BHP"}}
	srv := backtestServer(t, fake)
	ctx := resolvedPremiumContext()

	for _, id := range []int64{102, 103, 999} {
		_, err := srv.GetBacktestRun(anonymousContext(), connect.NewRequest(&shortsv1alpha1.GetBacktestRunRequest{StrategyId: spec.StrategyCrowdedShortBreakout, RunId: id}))
		assert.Equal(t, connect.CodeNotFound, connect.CodeOf(err), "run %d is not served", id)
		_, err = srv.ListBacktestTrades(ctx, connect.NewRequest(&shortsv1alpha1.ListBacktestTradesRequest{RunId: id}))
		assert.Equal(t, connect.CodeNotFound, connect.CodeOf(err), "run %d's trades are not served", id)
	}
	_, err := srv.GetBacktestRun(anonymousContext(), connect.NewRequest(&shortsv1alpha1.GetBacktestRunRequest{StrategyId: spec.StrategyMinerviniTrend, RunId: 101}))
	assert.Equal(t, connect.CodeNotFound, connect.CodeOf(err), "another strategy's run is not found under this strategy")
}

// A not-computable outcome fetched by id returns its stored state, never Unavailable (item 1).
func TestNotComputableRunByIdReturnsItsStoredState(t *testing.T) {
	fake := newBacktestFake()
	rules, recipe := liveKeys(t, spec.StrategyZangerBreakout)
	nc := shortsstore.BacktestRunRow{
		ID: 7, StrategyID: spec.StrategyZangerBreakout, RulesHash: rules, RecipeHash: recipe,
		ComputableFrom: "2025-08-31", FiscalLabel: "FY2024",
		Summary: []byte(`{"state":"not_computable","share":0.42,"threshold":0.5}`),
	}
	fake.addRun(nc, true)
	srv := backtestServer(t, fake)
	resp, err := srv.GetBacktestRun(anonymousContext(), connect.NewRequest(&shortsv1alpha1.GetBacktestRunRequest{StrategyId: spec.StrategyZangerBreakout, RunId: 7}))
	require.NoError(t, err)
	assert.Equal(t, "not_computable", resp.Msg.Run.State)
	assert.Equal(t, "FY2024", resp.Msg.Run.FiscalLabel)
	assert.Contains(t, resp.Msg.Run.StateReason, "Not computable before FY2024")
	assert.InDelta(t, 42, resp.Msg.Run.ComputableSharePct, 1e-9)
}

// Before v1 is live a strategy's answer is run_required with its reason, never not_computable.
func TestALiveVersionWithNoRecipeIsRunRequiredNotNotComputable(t *testing.T) {
	fake := newBacktestFake()
	srv := backtestServer(t, fake)
	lb := liveBacktest{strategyID: spec.StrategyCrowdedShortBreakout, found: true, hash: strings.Repeat("a", 64)}
	bs, err := srv.backtestStateOf(context.Background(), lb)
	require.NoError(t, err)
	assert.Equal(t, backtestStateRunRequired, bs.state)
	assert.Contains(t, bs.reason, "no backtest recipe")
}

// A not-computable outcome is not hidden by a request that is running (item 9).
func TestNotComputableIsNotHiddenByARunningRequest(t *testing.T) {
	fake := newBacktestFake()
	rules, recipe := liveKeys(t, spec.StrategyZangerBreakout)
	fake.notComputable[spec.StrategyZangerBreakout] = shortsstore.BacktestRunRow{
		ID: 7, StrategyID: spec.StrategyZangerBreakout, RulesHash: rules, RecipeHash: recipe,
		ComputableFrom: "2025-08-31", FiscalLabel: "FY2024", Summary: []byte(`{"state":"not_computable"}`),
	}
	fake.running[spec.StrategyZangerBreakout] = time.Date(2026, 11, 6, 14, 2, 0, 0, time.UTC)
	srv := backtestServer(t, fake)
	resp, err := srv.GetBacktestRun(anonymousContext(), connect.NewRequest(&shortsv1alpha1.GetBacktestRunRequest{StrategyId: spec.StrategyZangerBreakout}))
	require.NoError(t, err)
	assert.Equal(t, "not_computable", resp.Msg.Run.State)
}

// The live state of a running request and a missing run.
func TestStatesOfAStrategyWithoutAPublishedRun(t *testing.T) {
	fake := newBacktestFake()
	fake.running[spec.StrategyCANSLIM] = time.Date(2026, 11, 6, 14, 2, 0, 0, time.UTC)
	srv := backtestServer(t, fake)
	running, err := srv.GetBacktestRun(anonymousContext(), connect.NewRequest(&shortsv1alpha1.GetBacktestRunRequest{StrategyId: spec.StrategyCANSLIM}))
	require.NoError(t, err)
	assert.Equal(t, "running", running.Msg.Run.State)
	assert.Equal(t, "2026-11-06T14:02:00Z", running.Msg.Run.RunningSince)
	assert.NotEmpty(t, running.Msg.Run.StateReason)

	req, err := srv.GetBacktestRun(anonymousContext(), connect.NewRequest(&shortsv1alpha1.GetBacktestRunRequest{StrategyId: spec.StrategyMinerviniTrend}))
	require.NoError(t, err)
	assert.Equal(t, "run_required", req.Msg.Run.State)
	assert.Contains(t, req.Msg.Run.StateReason, "No completed backtest for rules v1")
}

// The computed run serves its tables, the coverage by year and month under both measures, the identity and
// the replay agreement.
func TestComputedRunServesItsTablesAndSeries(t *testing.T) {
	fake := newBacktestFake()
	fake.publish(t, spec.StrategyCrowdedShortBreakout, 101)
	srv := backtestServer(t, fake)

	resp, err := srv.GetBacktestRun(anonymousContext(), connect.NewRequest(&shortsv1alpha1.GetBacktestRunRequest{StrategyId: spec.StrategyCrowdedShortBreakout}))
	require.NoError(t, err)
	run := resp.Msg.Run
	assert.Equal(t, "published", run.State)
	assert.True(t, run.RulesMatchLive)
	assert.True(t, run.EngineMatchesLive)
	assert.Equal(t, "weekly", run.SeriesResolution, "the since-2019 window is weekly")
	assert.Equal(t, "since_2019_05", run.WindowId)
	assert.LessOrEqual(t, len(run.Series), 500)

	labels := map[string]bool{}
	for _, w := range run.Windows {
		labels[w.Window] = true
	}
	for _, id := range []string{windowSince2019, windowSince2023, windowTrailing12, windowLive} {
		assert.True(t, labels[id], "window %s is served", id)
	}
	require.NotEmpty(t, run.Annual)
	assert.Equal(t, "partial", run.Annual[0].State)
	assert.Equal(t, "to_date", run.Annual[len(run.Annual)-1].State, "the current year is measured to date")
	require.NotEmpty(t, run.Monthly)
	assert.Equal(t, "to_date", run.Monthly[len(run.Monthly)-1].State)
	assert.Equal(t, "MTD", run.Monthly[len(run.Monthly)-1].Label)

	require.Len(t, run.Coverage, 8)
	assert.True(t, run.Coverage[0].Measurable)
	assert.InDelta(t, 70, run.Coverage[0].CoveragePct, 1e-9)
	assert.True(t, run.Coverage[0].AllReportedMeasurable)
	assert.InDelta(t, 90, run.Coverage[0].AllReportedPct, 1e-9)
	assert.NotEmpty(t, run.CoverageMonthly)
	// The run's RIO trade is open at its end, but the paper track closed it on 30 October, before the run's
	// end, so it does not agree; the paper trade therefore counts as a paper-only disagreement too.
	assert.Equal(t, "Replay diverges: 0 of 2 trades agree", run.ReplayAgreement)
	assert.Equal(t, "measured", run.Survivorship.Measurement, "a measured run states 8.2's measured value")
}

// Minervini's coverage is the all-reported measure, and the years before 2025 are not measurable (1.5, 1.7).
func TestMinerviniCoverageUsesTheAllReportedMeasureFrom2025(t *testing.T) {
	fake := newBacktestFake()
	fake.publishWith(t, spec.StrategyMinerviniTrend, 201, backtest.MeasurementASICOnly)
	srv := backtestServer(t, fake)
	resp, err := srv.GetBacktestRun(anonymousContext(), connect.NewRequest(&shortsv1alpha1.GetBacktestRunRequest{StrategyId: spec.StrategyMinerviniTrend}))
	require.NoError(t, err)
	run := resp.Msg.Run
	assert.Contains(t, run.Recipe.GetEntry(), "Minervini waits for a volatility-contraction entry", "the recipe entry carries the Minervini note")
	assert.Equal(t, "partial", run.Survivorship.Measurement)
	assert.Contains(t, run.Survivorship.Caveat, "ASIC-reported names only")
	for _, a := range run.Annual {
		if a.Year < 2025 {
			assert.Equal(t, measureNotMeasured, a.CoverageMeasure, "year %d is not measurable", a.Year)
			assert.False(t, a.CoverageMeasurable)
		} else {
			assert.Equal(t, measureAllReported, a.CoverageMeasure, "year %d uses the all-reported measure", a.Year)
			assert.True(t, a.CoverageMeasurable)
			assert.InDelta(t, 90, a.CoveragePct, 1e-9)
		}
	}
	ev, err := srv.ListStrategyEvidence(anonymousContext(), connect.NewRequest(&shortsv1alpha1.ListStrategyEvidenceRequest{}))
	require.NoError(t, err)
	for _, e := range ev.Msg.Strategies {
		if e.StrategyId == spec.StrategyMinerviniTrend {
			assert.Contains(t, e.Survivorship, "ASIC-reported names only", "the evidence carries the Minervini caveat")
		}
	}
}

// Daily resolution is served for a window of 500 sessions or fewer, and weekly otherwise; series_resolution
// says which (item 11).
func TestDailyResolutionIsServedForAShortWindowAndWeeklyForALongOne(t *testing.T) {
	fake := newBacktestFake()
	fake.publish(t, spec.StrategyCrowdedShortBreakout, 101)
	srv := backtestServer(t, fake)

	short, err := srv.GetBacktestRun(anonymousContext(), connect.NewRequest(&shortsv1alpha1.GetBacktestRunRequest{
		StrategyId: spec.StrategyCrowdedShortBreakout, Resolution: "daily", Window: "trailing_12m",
	}))
	require.NoError(t, err)
	assert.Equal(t, "daily", short.Msg.Run.SeriesResolution)
	assert.LessOrEqual(t, len(short.Msg.Run.Series), 500)
	assert.Greater(t, len(short.Msg.Run.Series), 200, "a year of daily sessions")

	long, err := srv.GetBacktestRun(anonymousContext(), connect.NewRequest(&shortsv1alpha1.GetBacktestRunRequest{
		StrategyId: spec.StrategyCrowdedShortBreakout, Resolution: "daily",
	}))
	require.NoError(t, err)
	assert.Equal(t, "weekly", long.Msg.Run.SeriesResolution, "more than 500 sessions falls back to weekly")
	assert.LessOrEqual(t, len(long.Msg.Run.Series), 500)

	_, err = srv.GetBacktestRun(anonymousContext(), connect.NewRequest(&shortsv1alpha1.GetBacktestRunRequest{StrategyId: spec.StrategyCrowdedShortBreakout, Window: "decade"}))
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
}

// The served window's drawdown reaches its reported maximum: the trough is in the series (item 14).
func TestServedSeriesReachesTheWindowsReportedDrawdown(t *testing.T) {
	fake := newBacktestFake()
	fake.publish(t, spec.StrategyCrowdedShortBreakout, 101)
	srv := backtestServer(t, fake)
	resp, err := srv.GetBacktestRun(anonymousContext(), connect.NewRequest(&shortsv1alpha1.GetBacktestRunRequest{StrategyId: spec.StrategyCrowdedShortBreakout}))
	require.NoError(t, err)
	var minDD float64
	for _, p := range resp.Msg.Run.Series {
		if p.DrawdownPct < minDD {
			minDD = p.DrawdownPct
		}
	}
	var reported float64
	for _, w := range resp.Msg.Run.Windows {
		if w.Window == windowSince2019 {
			reported = w.MaxDrawdownPct
		}
	}
	assert.InDelta(t, reported, minDD, 0.011, "the drawn trough reaches the reported maximum, to the cent")
}

// The trades of a run page by keyset, filter in SQL, and report the total over every page.
func TestListBacktestTradesPagesAndFilters(t *testing.T) {
	fake := newBacktestFake()
	fake.publish(t, spec.StrategyCrowdedShortBreakout, 101)
	srv := backtestServer(t, fake)
	ctx := userContext("free")

	page1, err := srv.ListBacktestTrades(ctx, connect.NewRequest(&shortsv1alpha1.ListBacktestTradesRequest{RunId: 101, PageSize: 2}))
	require.NoError(t, err)
	assert.Len(t, page1.Msg.Trades, 2)
	assert.Equal(t, int32(4), page1.Msg.Total)
	require.NotEmpty(t, page1.Msg.NextPageToken)

	page2, err := srv.ListBacktestTrades(ctx, connect.NewRequest(&shortsv1alpha1.ListBacktestTradesRequest{RunId: 101, PageSize: 2, PageToken: page1.Msg.NextPageToken}))
	require.NoError(t, err)
	assert.Len(t, page2.Msg.Trades, 2)
	assert.Empty(t, page2.Msg.NextPageToken, "the last page has no token")
	assert.Equal(t, int32(3), page2.Msg.Trades[0].Seq)

	byStock, err := srv.ListBacktestTrades(ctx, connect.NewRequest(&shortsv1alpha1.ListBacktestTradesRequest{RunId: 101, StockCode: "cba"}))
	require.NoError(t, err)
	require.Len(t, byStock.Msg.Trades, 1)
	assert.Equal(t, "CBA", byStock.Msg.Trades[0].StockCode)
	assert.Equal(t, int32(1), byStock.Msg.Total)

	byReason, err := srv.ListBacktestTrades(ctx, connect.NewRequest(&shortsv1alpha1.ListBacktestTradesRequest{RunId: 101, ExitReason: "pivot_stop"}))
	require.NoError(t, err)
	assert.Equal(t, int32(1), byReason.Msg.Total)

	_, err = srv.ListBacktestTrades(ctx, connect.NewRequest(&shortsv1alpha1.ListBacktestTradesRequest{RunId: 101, PageSize: 201}))
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
	_, err = srv.ListBacktestTrades(ctx, connect.NewRequest(&shortsv1alpha1.ListBacktestTradesRequest{RunId: 101, PageToken: "x"}))
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
}

// The trade summary states the in-sample record: closed trades that entered before live_from, with a has_
// flag on each figure (1.5, item 19, item 21).
func TestTradeSummaryIsTheInSampleRecord(t *testing.T) {
	fake := newBacktestFake()
	fake.publish(t, spec.StrategyCrowdedShortBreakout, 101)
	srv := backtestServer(t, fake)
	resp, err := srv.GetBacktestRun(anonymousContext(), connect.NewRequest(&shortsv1alpha1.GetBacktestRunRequest{StrategyId: spec.StrategyCrowdedShortBreakout}))
	require.NoError(t, err)
	s := resp.Msg.Run.TradeSummary
	assert.Equal(t, int32(2), s.Closed, "BHP and CBA entered and exited before live_from")
	assert.Equal(t, int32(0), s.OpenAtEnd, "the open RIO trade entered after the freeze")
	assert.True(t, s.HasWinRate)
	assert.InDelta(t, 50, s.WinRatePct, 1e-9)
	assert.True(t, s.HasBest)
	assert.InDelta(t, 9.5, s.BestPct, 1e-9)
	assert.True(t, s.HasWorst)
	assert.InDelta(t, -5.5, s.WorstPct, 1e-9)
	assert.True(t, s.HasAvgWin)
	assert.True(t, s.HasAvgLoss)
	assert.True(t, s.HasAvgHold)
}

// Entry scores are rounded to one decimal, so float32 noise does not reach a reader (item 21).
func TestEntryScoreIsRoundedToOneDecimal(t *testing.T) {
	assert.Equal(t, 80.4, roundTenth(80.44))
	assert.Equal(t, -0.3, roundTenth(-0.25001))
	assert.Equal(t, 0.0, roundTenth(0))
}

// The data quality counts are served as fields, with the consolidation note (item 18).
func TestDataQualityIsServedAsFields(t *testing.T) {
	fake := newBacktestFake()
	fake.publish(t, spec.StrategyCrowdedShortBreakout, 101)
	srv := backtestServer(t, fake)
	resp, err := srv.GetBacktestRun(anonymousContext(), connect.NewRequest(&shortsv1alpha1.GetBacktestRunRequest{StrategyId: spec.StrategyCrowdedShortBreakout}))
	require.NoError(t, err)
	dq := resp.Msg.Run.DataQuality
	require.NotNil(t, dq)
	assert.Equal(t, int32(2), dq.DelistingExits)
	assert.Equal(t, int32(1), dq.CorporateActionExits)
	assert.Equal(t, int32(3), dq.FallbackClose)
	assert.Equal(t, int32(4), dq.CancelledEntries["liquidity"])
	assert.Contains(t, dq.ConsolidationNote, "Pre-re-sync consolidations")
}

// The disclosures carry 1.8's copy, verbatim where the spec fixes it (item 17).
func TestDisclosuresCarryTheSpecCopy(t *testing.T) {
	fake := newBacktestFake()
	fake.publish(t, spec.StrategyCrowdedShortBreakout, 101)
	srv := backtestServer(t, fake)
	resp, err := srv.GetBacktestRun(anonymousContext(), connect.NewRequest(&shortsv1alpha1.GetBacktestRunRequest{StrategyId: spec.StrategyCrowdedShortBreakout}))
	require.NoError(t, err)
	all := strings.Join(resp.Msg.Run.Disclosures, "\n")
	assert.Contains(t, all, "not a record of trading")
	assert.NotContains(t, all, "not record trading")
	assert.Contains(t, all, "If a strategy beats the ASX 200 but not the reference, the edge may be the data rather than the rules.")
	assert.Contains(t, all, "assumed for the whole history")
	assert.Contains(t, all, "Prices are missing for companies that delisted before about 2025.")
	assert.Equal(t, "Same-data reference: liquid crowded shorts, equal weight", resp.Msg.Run.Identity.ReferenceName, "the reference names the recipe's universe")
	assert.Regexp(t, `^\d{4}-\d{2}-\d{2}$`, resp.Msg.Run.Identity.RunDate)
}

// The reference fallback: a run whose daily series carries no reference states the summary's figures on the
// since-2019 window (item 6).
func TestReferenceFallsBackToTheSummaryWhenTheSeriesHasNone(t *testing.T) {
	fake := newBacktestFake()
	fake.publish(t, spec.StrategyCrowdedShortBreakout, 101)
	var series storedSeries
	require.NoError(t, json.Unmarshal(fake.series[101], &series))
	series.R = make([]float64, len(series.D))
	raw, err := json.Marshal(series)
	require.NoError(t, err)
	fake.series[101] = raw
	srv := backtestServer(t, fake)
	resp, err := srv.GetBacktestRun(anonymousContext(), connect.NewRequest(&shortsv1alpha1.GetBacktestRunRequest{StrategyId: spec.StrategyCrowdedShortBreakout}))
	require.NoError(t, err)
	for _, w := range resp.Msg.Run.Windows {
		if w.Window == windowSince2019 {
			assert.True(t, w.HasReferenceTotalReturn)
			assert.InDelta(t, 40, w.ReferenceTotalReturnPct, 1e-9, "the summary's reference return")
		}
	}
	for _, p := range resp.Msg.Run.Series {
		assert.Zero(t, p.Reference, "no daily reference is served for a run that has none")
	}
}

// The served series carries a reference level on every point of a run published with the reference.
func TestReferenceLevelIsOnEverySeriesPoint(t *testing.T) {
	fake := newBacktestFake()
	fake.publish(t, spec.StrategyCrowdedShortBreakout, 101)
	srv := backtestServer(t, fake)
	resp, err := srv.GetBacktestRun(anonymousContext(), connect.NewRequest(&shortsv1alpha1.GetBacktestRunRequest{StrategyId: spec.StrategyCrowdedShortBreakout}))
	require.NoError(t, err)
	// A paper session carries the run's own reference where the run has one for the day (item 7: prefer
	// the run's own levels), so every point of this run, in-sample or recorded, has a reference.
	for _, p := range resp.Msg.Run.Series {
		assert.Greater(t, p.Reference, 0.0, p.Date)
	}
}

// Cache (item 2): a second read of the public run is served without touching the store; an error is never
// stored, so the next read succeeds.
func TestPublicRunReadsAreCachedAndErrorsAreNot(t *testing.T) {
	fake := newBacktestFake()
	fake.publish(t, spec.StrategyCrowdedShortBreakout, 101)
	fake.failNextSeries = true
	srv := backtestServer(t, fake)
	req := func() *connect.Request[shortsv1alpha1.GetBacktestRunRequest] {
		return connect.NewRequest(&shortsv1alpha1.GetBacktestRunRequest{StrategyId: spec.StrategyCrowdedShortBreakout})
	}
	_, err := srv.GetBacktestRun(anonymousContext(), req())
	require.Error(t, err, "the failed read is returned")
	first, err := srv.GetBacktestRun(anonymousContext(), req())
	require.NoError(t, err, "the failure was not cached")
	reads := fake.seriesReads
	_, err = srv.GetBacktestRun(anonymousContext(), req())
	require.NoError(t, err)
	assert.Equal(t, reads, fake.seriesReads, "the second success is served from the cache")
	assert.NotNil(t, first.Msg.Run)
}

// Mutating a returned answer does not alter the cached one: every reader gets its own copy.
func TestCachedAnswersAreCopiedToEachCaller(t *testing.T) {
	fake := newBacktestFake()
	fake.publish(t, spec.StrategyCrowdedShortBreakout, 101)
	srv := backtestServer(t, fake)
	req := connect.NewRequest(&shortsv1alpha1.GetBacktestRunRequest{StrategyId: spec.StrategyCrowdedShortBreakout})
	a, err := srv.GetBacktestRun(anonymousContext(), req)
	require.NoError(t, err)
	a.Msg.Run.State = "tampered"
	b, err := srv.GetBacktestRun(anonymousContext(), req)
	require.NoError(t, err)
	assert.Equal(t, "published", b.Msg.Run.State)
}

// The evidence's today counts and the chain share one paper read per strategy; the list is cached.
func TestListStrategyEvidenceIsCached(t *testing.T) {
	fake := newBacktestFake()
	fake.publish(t, spec.StrategyCrowdedShortBreakout, 101)
	srv := backtestServer(t, fake)
	_, err := srv.ListStrategyEvidence(anonymousContext(), connect.NewRequest(&shortsv1alpha1.ListStrategyEvidenceRequest{}))
	require.NoError(t, err)
	reads := fake.publishedReads
	_, err = srv.ListStrategyEvidence(anonymousContext(), connect.NewRequest(&shortsv1alpha1.ListStrategyEvidenceRequest{}))
	require.NoError(t, err)
	assert.Equal(t, reads, fake.publishedReads, "a complete answer is served from the cache")
}

// Degraded schema (1.7): a database without the backtest or paper tables reads as run_required, never an error.
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
		assert.NotNil(t, e.Paper)
		assert.True(t, e.Paper.TooShort)
	}

	_, err = srv.ListBacktestTrades(resolvedPremiumContext(), connect.NewRequest(&shortsv1alpha1.ListBacktestTradesRequest{RunId: 1}))
	assert.Equal(t, connect.CodeNotFound, connect.CodeOf(err))
}

// The request validation of the backtest rpcs.
func TestBacktestRequestValidation(t *testing.T) {
	fake := newBacktestFake()
	fake.publish(t, spec.StrategyCrowdedShortBreakout, 101)
	srv := backtestServer(t, fake)

	_, err := srv.GetBacktestRun(anonymousContext(), connect.NewRequest(&shortsv1alpha1.GetBacktestRunRequest{StrategyId: "nope"}))
	assert.Equal(t, connect.CodeNotFound, connect.CodeOf(err))
	_, err = srv.GetBacktestRun(anonymousContext(), connect.NewRequest(&shortsv1alpha1.GetBacktestRunRequest{StrategyId: spec.StrategyCrowdedShortBreakout, Resolution: "hourly"}))
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))

	ctx := userContext("free")
	_, err = srv.CompareStrategies(ctx, connect.NewRequest(&shortsv1alpha1.CompareStrategiesRequest{Refs: []string{spec.StrategyCrowdedShortBreakout}}))
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
	_, err = srv.CompareStrategies(ctx, connect.NewRequest(&shortsv1alpha1.CompareStrategiesRequest{Refs: []string{
		spec.StrategyCrowdedShortBreakout, spec.StrategyMinerviniTrend, spec.StrategyZangerBreakout, spec.StrategyCANSLIM,
	}}))
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
	_, err = srv.CompareStrategies(ctx, connect.NewRequest(&shortsv1alpha1.CompareStrategiesRequest{Refs: []string{
		spec.StrategyCrowdedShortBreakout, spec.StrategyCrowdedShortBreakout,
	}}))
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
	_, err = srv.CompareStrategies(ctx, connect.NewRequest(&shortsv1alpha1.CompareStrategiesRequest{Refs: []string{
		spec.StrategyCrowdedShortBreakout, "variant:abc",
	}}))
	assert.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
}

// Two computed strategies compare over the sessions both hold, with curves rebased to 100,000, a correlation,
// and the recipe lines that differ (item 16 names the rule diff in the response).
func TestCompareStrategiesOverTheCommonWindow(t *testing.T) {
	fake := newBacktestFake()
	fake.publish(t, spec.StrategyCrowdedShortBreakout, 101)
	fake.publish(t, spec.StrategyMinerviniTrend, 102)
	srv := backtestServer(t, fake)

	resp, err := srv.CompareStrategies(resolvedPremiumContext(), connect.NewRequest(&shortsv1alpha1.CompareStrategiesRequest{
		Refs: []string{spec.StrategyCrowdedShortBreakout, spec.StrategyMinerviniTrend},
	}))
	require.NoError(t, err)
	assert.Equal(t, "common", resp.Msg.WindowId)
	require.Len(t, resp.Msg.Entries, 2)
	for _, e := range resp.Msg.Entries {
		assert.Equal(t, "published", e.State)
		require.NotNil(t, e.Window)
		require.NotEmpty(t, e.Series)
		assert.InDelta(t, 100000, e.Series[0].Equity, 1e-6, "rebased to 100,000 on the first session")
	}
	require.Len(t, resp.Msg.Correlations, 1)
	assert.True(t, resp.Msg.Correlations[0].HasCorrelation)
	assert.NotEmpty(t, resp.Msg.RuleDiffs, "the two recipes differ")
}

// A strategy with no published run is returned in its state, with no common window.
func TestCompareReturnsStatesWhenAStrategyHasNoCurve(t *testing.T) {
	fake := newBacktestFake()
	fake.publish(t, spec.StrategyCrowdedShortBreakout, 101)
	srv := backtestServer(t, fake)
	resp, err := srv.CompareStrategies(resolvedPremiumContext(), connect.NewRequest(&shortsv1alpha1.CompareStrategiesRequest{
		Refs: []string{spec.StrategyCrowdedShortBreakout, spec.StrategyZangerBreakout},
	}))
	require.NoError(t, err)
	assert.Empty(t, resp.Msg.WindowId)
	require.Len(t, resp.Msg.Entries, 2)
	assert.Equal(t, "run_required", resp.Msg.Entries[1].State)
	assert.Empty(t, resp.Msg.Correlations)
}

// Correlation is deterministic and needs a sensible overlap (item 21).
func TestCorrelateOfIdenticalFlatAndShortSeries(t *testing.T) {
	start := civil.Date{Year: 2025, Month: time.January, Day: 2}
	a, b, flat := map[civil.Date]float64{}, map[civil.Date]float64{}, map[civil.Date]float64{}
	for k := 1; k < 60; k++ {
		d := start.AddDays(k)
		a[d] = math.Sin(float64(k))
		b[d] = math.Sin(float64(k))
		flat[d] = 0
	}
	c, n, ok := correlate(a, b)
	assert.True(t, ok)
	assert.Equal(t, 59, n)
	assert.InDelta(t, 1, c, 1e-9)
	_, _, ok = correlate(a, flat)
	assert.False(t, ok, "a flat series has no correlation")
	short := map[civil.Date]float64{}
	for k := 1; k < 10; k++ {
		short[start.AddDays(k)] = math.Sin(float64(k))
	}
	_, n, ok = correlate(short, short)
	assert.False(t, ok, "fewer than the minimum overlap states no correlation")
	assert.Equal(t, 9, n)
}

// The stored summary decodes into the package's own types, so a run written by the job is read back exactly.
func TestStoredSummaryRoundTripsThroughTheBacktestTypes(t *testing.T) {
	cutoff := civil.Date{Year: 2026, Month: time.October, Day: 1}
	share := 0.42
	sum := storedSummary{
		State:     "computed",
		Reference: backtest.WindowFigures{ID: "reference", Start: cutoff, End: cutoff.AddDays(30)},
		Diff:      backtest.DiffNote{State: "changed", RewrittenCount: 3, PreviousCutOff: cutoff, HasCAGRShift: true, CAGRShiftPP: 0.3},
		Share:     &share,
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
	assert.NotContains(t, diffNoteOf(back.Diff), "3 ASIC", "the revision copy is about codes, and none was revised here")
}

// The revised-reports copy counts codes (item 17).
func TestRevisedCountIsStatedAsCodes(t *testing.T) {
	assert.Contains(t, diffNoteOf(backtest.DiffNote{State: "changed", RevisedCount: 2}), "2 ASIC product codes revised")
}

// The payload of a realistic 7.5-year run is measured and kept near the 60 KB budget (item 13).
func TestPayloadOfARealisticRunStaysNearItsBudget(t *testing.T) {
	fake := newBacktestFake()
	fake.publish(t, spec.StrategyCrowdedShortBreakout, 101)
	srv := backtestServer(t, fake)
	resp, err := srv.GetBacktestRun(anonymousContext(), connect.NewRequest(&shortsv1alpha1.GetBacktestRunRequest{StrategyId: spec.StrategyCrowdedShortBreakout}))
	require.NoError(t, err)
	b, err := protojson.Marshal(resp.Msg)
	require.NoError(t, err)
	t.Logf("GetBacktestRun (7.5 years, weekly, two-measure monthly coverage): %d bytes, %d series points, %d monthly coverage rows",
		len(b), len(resp.Msg.Run.Series), len(resp.Msg.Run.CoverageMonthly))
	// The target is 60 KB. The measured run is 82.4 KB: the five sensitivity runs of 5.12 (required), the two identity
	// fingerprints, and the overlap fields of the windows (required, PR-19 review item 1) added about 4 KB to the
	// 78.6 KB measured before. The 398 weekly points are about 42 KB of it, the monthly table about 13 KB and the
	// monthly coverage about 9 KB. The guard holds the measured figure with headroom; the target is not met.
	assert.LessOrEqual(t, len(b), 84*1024, "the realistic run stays within 84 KB (the target is 60 KB)")
}

// paperFrom is the paper track from a session on or after from, with the raw XJT level truth(m) on each
// session and the given engine version.
func paperFrom(dates []civil.Date, from civil.Date, truth func(m int) float64, engineVersion string) []shortsstore.PaperEquityRow {
	var out []shortsstore.PaperEquityRow
	for _, d := range dates {
		if d.Before(from) {
			continue
		}
		m := len(out)
		b := truth(m)
		out = append(out, shortsstore.PaperEquityRow{
			AsOf: d.String(), Equity: 300000 * (1 + 0.0004*float64(m)), Cash: 30000, Positions: 4,
			Benchmark: &b, EngineVersion: engineVersion,
		})
	}
	return out
}

// The paper track is kept from live_from and chains at its actual first session. The in-sample curve ends the
// session before live_from, and the sessions between that and the track's first are a named gap, never a bridge
// (items 1 and 17). A track that starts a session late is rebased on the last in-sample level.
func TestPaperTrackChainsAtItsActualStart(t *testing.T) {
	dates := weekdays(civil.Date{Year: 2026, Month: time.September, Day: 1}, civil.Date{Year: 2026, Month: time.October, Day: 15})
	series := fixtureSeries(dates)
	actual := backtestFixtureLiveFrom.AddDays(1) // the Friday after live_from
	paper := paperFrom(dates, actual, func(m int) float64 { return 5000 }, engine.Version)
	chain, err := buildChainedRun(series, backtestFixtureLiveFrom.AddDays(-1).String(), paper)
	require.NoError(t, err)
	require.True(t, chain.hasPaper)
	assert.Equal(t, backtestFixtureLiveFrom, chain.liveFrom, "the freeze is live_from")
	assert.Equal(t, backtestFixtureLiveFrom, chain.frozenAt)
	assert.Equal(t, backtestFixtureLiveFrom.AddDays(-1), chain.inSampleEnd, "the in-sample figures end the session before live_from")
	assert.Equal(t, actual, chain.startAt, "the paper track is recorded from its actual start")
	assert.True(t, chain.hasGap)
	assert.Equal(t, backtestFixtureLiveFrom, chain.gapFrom)
	assert.Equal(t, backtestFixtureLiveFrom, chain.gapTo)

	var baseIdx int
	for k, d := range dates {
		if d == backtestFixtureLiveFrom.AddDays(-1) {
			baseIdx = k
		}
	}
	var sawLiveFrom bool
	for _, d := range chain.days {
		if d.date == backtestFixtureLiveFrom {
			sawLiveFrom = true
		}
		if d.date == actual {
			assert.InDelta(t, series.E[baseIdx], d.equity, 1e-9, "the track's first session starts at the last in-sample level")
			assert.True(t, d.recorded)
		}
	}
	assert.False(t, sawLiveFrom, "live_from itself is in the gap: no figure stands for it")
	figs, err := backtest.Windows(chain.bt, chain.paper, chain.liveFrom, nil)
	require.NoError(t, err)
	for _, f := range figs {
		if f.ID == backtest.WindowLiveSinceFreeze {
			assert.Equal(t, actual.String(), f.Start.String(), "live since freeze starts at the track's actual start")
		}
	}

	// The run states the start, and the since window's note names the in-sample end, the start and the gap.
	fake := newBacktestFake()
	fake.publish(t, spec.StrategyCrowdedShortBreakout, 101)
	fake.paperEq = paper
	srv := backtestServer(t, fake)
	resp, err := srv.GetBacktestRun(anonymousContext(), connect.NewRequest(&shortsv1alpha1.GetBacktestRunRequest{StrategyId: spec.StrategyCrowdedShortBreakout}))
	require.NoError(t, err)
	assert.Equal(t, actual.String(), resp.Msg.Run.PaperStart)
	for _, w := range resp.Msg.Run.Windows {
		if w.Window == windowSince2019 {
			assert.Equal(t, "in-sample to 2026-09-30, recorded from 2026-10-02; no figures from 2026-10-01 to 2026-10-01", w.Note)
		}
	}
}

// Freeze, in-sample end, track start and the notes agree, the same way, in every place the run states them
// (item 1): the disclosure, the window notes, the identity and the paper summary.
func TestLateStartedTrackAgreesAcrossDisclosureNotesIdentityAndSummary(t *testing.T) {
	fake := newBacktestFake()
	fake.publish(t, spec.StrategyCrowdedShortBreakout, 101)
	dates := weekdays(civil.Date{Year: 2026, Month: time.September, Day: 1}, civil.Date{Year: 2026, Month: time.November, Day: 5})
	fake.paperEq = paperFrom(dates, backtestFixtureLiveFrom.AddDays(1), func(m int) float64 { return 5000 }, engine.Version)
	srv := backtestServer(t, fake)
	resp, err := srv.GetBacktestRun(anonymousContext(), connect.NewRequest(&shortsv1alpha1.GetBacktestRunRequest{StrategyId: spec.StrategyCrowdedShortBreakout}))
	require.NoError(t, err)
	run := resp.Msg.Run

	disclosure := ""
	for _, d := range run.Disclosures {
		if strings.HasPrefix(d, "In-sample ·") {
			disclosure = d
		}
	}
	assert.Equal(t, "In-sample · rules frozen 2026-10-01: the figures to 2026-09-30 are in-sample; the recorded paper track follows from 2026-10-02.", disclosure)
	assert.Equal(t, "2026-09-30", run.Identity.InSampleUntil, "identity: the last in-sample session is live_from minus one")
	assert.Equal(t, "2026-10-02", run.PaperStart)
	for _, w := range run.Windows {
		if w.Window == windowSince2019 {
			assert.Contains(t, w.Note, "in-sample to 2026-09-30, recorded from 2026-10-02")
		}
		if w.Window == windowLive {
			assert.Equal(t, "paper track only, recorded from 2026-10-02", w.Note)
		}
	}
	ev, err := srv.ListStrategyEvidence(anonymousContext(), connect.NewRequest(&shortsv1alpha1.ListStrategyEvidenceRequest{}))
	require.NoError(t, err)
	paper := findEvidence(t, ev.Msg.Strategies, spec.StrategyCrowdedShortBreakout).Paper
	assert.Equal(t, "2026-10-01", paper.Since, "the summary's since is the freeze")
	assert.Equal(t, "2026-10-02", paper.RecordedFrom, "the summary's recorded_from is the track's first session")
}

// The probe: a benchmark that rises 1% a session. Chained from the raw XJT close on each paper session, the
// level is the truth to the last digit. Rebasing from paper[live_from] lost one session's move (1/1.01 = 0.9901).
func TestBenchmarkProbeChainsTheRawIndexLevelExactly(t *testing.T) {
	dates := weekdays(civil.Date{Year: 2026, Month: time.September, Day: 1}, civil.Date{Year: 2026, Month: time.October, Day: 30})
	truth := func(m int) float64 { return 1000 * math.Pow(1.01, float64(m)) }
	// The run has no sessions after live_from - 1, so every post-freeze benchmark comes from the paper track.
	var series storedSeries
	var inSample []civil.Date
	for _, d := range dates {
		if d.Before(backtestFixtureLiveFrom) {
			inSample = append(inSample, d)
		}
	}
	series = fixtureSeries(inSample)
	for k := range series.B {
		series.B[k] = 1000
	}
	paper := paperFrom(dates, backtestFixtureLiveFrom, truth, engine.Version)
	chain, err := buildChainedRun(series, backtestFixtureLiveFrom.AddDays(-1).String(), paper)
	require.NoError(t, err)
	var checked, m int
	for _, d := range chain.days {
		if !d.recorded {
			continue
		}
		checked++
		assert.Equal(t, 1.0, d.bench/truth(m), "%s: chained benchmark over the truth", d.date)
		m++
	}
	assert.Greater(t, checked, 10)
}

// On a session the run carries its own XJT level, the run's level is used, not the paper track's (item 7,
// point 2: prefer the run's B and R where the run has them).
func TestRunsOwnBenchmarkIsPreferredAfterTheFreeze(t *testing.T) {
	dates := weekdays(civil.Date{Year: 2019, Month: time.May, Day: 1}, civil.Date{Year: 2026, Month: time.November, Day: 5})
	series := fixtureSeries(dates)
	paper := fixturePaper(dates)
	chain, err := buildChainedRun(series, backtestFixtureLiveFrom.AddDays(-1).String(), paper)
	require.NoError(t, err)
	byDate := map[string]float64{}
	for k, d := range series.D {
		byDate[d] = series.B[k]
	}
	var seen int
	for _, d := range chain.days {
		if !d.recorded {
			continue
		}
		if run, ok := byDate[d.date.String()]; ok && run > 0 {
			seen++
			assert.Equal(t, run, d.bench, "%s: the run's own level", d.date)
		}
	}
	assert.Positive(t, seen)
}

// The win rate is computed across the freeze, from the paper trades' net returns, with the in-sample trades
// of the run. It does not disappear once the track starts (item 7, point 3).
func TestWinRateCrossesTheFreeze(t *testing.T) {
	fake := newBacktestFake()
	fake.publish(t, spec.StrategyCrowdedShortBreakout, 101)
	fake.paperTrades = []shortsstore.PaperTradeRow{
		{StockCode: "RIO", EntryDate: "2026-10-21", ExitDate: "2026-10-30", Status: "closed", NetReturnPct: 5, HasNet: true},
	}
	srv := backtestServer(t, fake)
	resp, err := srv.GetBacktestRun(anonymousContext(), connect.NewRequest(&shortsv1alpha1.GetBacktestRunRequest{StrategyId: spec.StrategyCrowdedShortBreakout}))
	require.NoError(t, err)
	var since *shortsv1alpha1.WindowMetrics
	for _, w := range resp.Msg.Run.Windows {
		if w.Window == windowSince2019 {
			since = w
		}
	}
	require.NotNil(t, since)
	assert.True(t, since.HasWinRate, "the win rate is served across the freeze")
	assert.InDelta(t, 66.67, since.WinRatePct, 0.01, "two winners of three: BHP, RIO; CBA lost")
	assert.Equal(t, int32(3), since.ClosedTrades)
}

// A track whose rows span two engine versions is one track: its equity chains across the change, every row is
// used, and the run and the paper summary report where the engine changed (item 4).
func TestPaperTrackSpanningAnEngineBumpIsOneTrack(t *testing.T) {
	dates := weekdays(civil.Date{Year: 2026, Month: time.September, Day: 1}, civil.Date{Year: 2026, Month: time.November, Day: 5})
	paper := paperFrom(dates, backtestFixtureLiveFrom, func(m int) float64 { return 5000 }, "1.1.1")
	bump := len(paper) / 2
	for k := bump; k < len(paper); k++ {
		paper[k].EngineVersion = "1.2.0"
	}
	series := fixtureSeries(dates)
	chain, err := buildChainedRun(series, backtestFixtureLiveFrom.AddDays(-1).String(), paper)
	require.NoError(t, err)
	recorded := 0
	for _, d := range chain.days {
		if d.recorded {
			recorded++
		}
	}
	assert.Equal(t, len(paper), recorded, "every paper row is used across the bump")

	summary := paperSummaryOf(backtestFixtureLiveFrom.String(), paper, nil)
	require.Len(t, summary.EngineSegments, 2)
	assert.Equal(t, "1.1.1", summary.EngineSegments[0].EngineVersion)
	assert.Equal(t, "1.2.0", summary.EngineSegments[1].EngineVersion)
	assert.Equal(t, int32(len(paper)), summary.EngineSegments[0].Sessions+summary.EngineSegments[1].Sessions)
	assert.Equal(t, paper[bump].AsOf, summary.EngineSegments[1].FirstSession, "the second segment starts where the engine changed")
	assert.Equal(t, paper[0].AsOf, summary.RecordedFrom)

	// The run serves the same segments.
	fake := newBacktestFake()
	fake.publish(t, spec.StrategyCrowdedShortBreakout, 101)
	fake.paperEq = paper
	srv := backtestServer(t, fake)
	resp, err := srv.GetBacktestRun(anonymousContext(), connect.NewRequest(&shortsv1alpha1.GetBacktestRunRequest{StrategyId: spec.StrategyCrowdedShortBreakout}))
	require.NoError(t, err)
	assert.Len(t, resp.Msg.Run.PaperEngineSegments, 2, "the run marks the engine change")
}

// truncateSeries keeps the fake run's stored series up to and including end: a run whose own sessions stop
// before its paper track does, as in production (the run's window end is the prices it read).
func truncateSeries(t *testing.T, fake *backtestStoreFake, runID int64, end civil.Date) {
	t.Helper()
	var series storedSeries
	require.NoError(t, json.Unmarshal(fake.series[runID], &series))
	keep := 0
	for keep < len(series.D) {
		d, err := civil.ParseDate(series.D[keep])
		require.NoError(t, err)
		if d.After(end) {
			break
		}
		keep++
	}
	series.D, series.E, series.B, series.R, series.DD, series.X = series.D[:keep], series.E[:keep], series.B[:keep], series.R[:keep], series.DD[:keep], series.X[:keep]
	raw, err := json.Marshal(series)
	require.NoError(t, err)
	fake.series[runID] = raw
}

// windowByID is the served window with the given id.
func windowByID(t *testing.T, run *shortsv1alpha1.BacktestRun, id string) *shortsv1alpha1.WindowMetrics {
	t.Helper()
	for _, w := range run.Windows {
		if w.Window == id {
			return w
		}
	}
	t.Fatalf("window %s is not served", id)
	return nil
}

// The default window has a paper tail after the run's last reference session. The reference figures are measured
// over the overlap, which ends at reference_to, and the strategy is measured over the same overlap (item 1).
func TestReferenceIsMeasuredOverTheOverlapWhenThePaperTrackHasATail(t *testing.T) {
	fake := newBacktestFake()
	fake.publish(t, spec.StrategyCrowdedShortBreakout, 101)
	truncateSeries(t, fake, 101, civil.Date{Year: 2026, Month: time.October, Day: 30})
	srv := backtestServer(t, fake)
	resp, err := srv.GetBacktestRun(anonymousContext(), connect.NewRequest(&shortsv1alpha1.GetBacktestRunRequest{StrategyId: spec.StrategyCrowdedShortBreakout}))
	require.NoError(t, err)
	w := windowByID(t, resp.Msg.Run, windowSince2019)

	assert.Equal(t, "2026-10-30", w.ReferenceTo, "the reference is measured to the run's last reference session")
	assert.Less(t, w.ReferenceTo, w.To, "the paper tail is after the reference")
	assert.True(t, w.HasReference, "the overlap spans more than 365 days, so the reference CAGR is served")
	assert.True(t, w.HasReferenceTotalReturn)
	assert.True(t, w.HasStrategyOverlapTotalReturn, "the strategy's figure is over the same overlap")
	assert.True(t, w.HasStrategyOverlapCagr)
	assert.NotEqual(t, w.TotalReturnPct, w.StrategyOverlapTotalReturnPct, "the overlap is not the whole window")
	assert.Greater(t, w.StrategyOverlapCagrPct, 0.0)
}

// A window that begins after the reference ends has no reference: no figure and no reference_to.
func TestWindowAfterTheReferenceEndsHasNoReference(t *testing.T) {
	fake := newBacktestFake()
	fake.publish(t, spec.StrategyCrowdedShortBreakout, 101)
	truncateSeries(t, fake, 101, civil.Date{Year: 2026, Month: time.September, Day: 15})
	srv := backtestServer(t, fake)
	resp, err := srv.GetBacktestRun(anonymousContext(), connect.NewRequest(&shortsv1alpha1.GetBacktestRunRequest{StrategyId: spec.StrategyCrowdedShortBreakout}))
	require.NoError(t, err)
	live := windowByID(t, resp.Msg.Run, windowLive)
	assert.False(t, live.HasReference)
	assert.False(t, live.HasReferenceTotalReturn)
	assert.False(t, live.HasStrategyOverlapTotalReturn)
	assert.Empty(t, live.ReferenceTo)
	assert.True(t, live.HasTotalReturn, "the strategy's own figures still stand")
}

// An overlap shorter than 365 calendar days is served as a total return with no CAGR (item 1, the CAGR rule).
func TestShortOverlapIsATotalReturnWithoutACAGR(t *testing.T) {
	fake := newBacktestFake()
	fake.publish(t, spec.StrategyCrowdedShortBreakout, 101)
	truncateSeries(t, fake, 101, civil.Date{Year: 2026, Month: time.March, Day: 2})
	srv := backtestServer(t, fake)
	resp, err := srv.GetBacktestRun(anonymousContext(), connect.NewRequest(&shortsv1alpha1.GetBacktestRunRequest{StrategyId: spec.StrategyCrowdedShortBreakout, Window: "trailing_12m"}))
	require.NoError(t, err)
	w := windowByID(t, resp.Msg.Run, windowTrailing12)
	assert.True(t, w.HasReferenceTotalReturn, "the overlap is a total return")
	assert.False(t, w.HasReference, "under 365 days there is no reference CAGR")
	assert.Equal(t, "2026-03-02", w.ReferenceTo)
	assert.True(t, w.HasStrategyOverlapTotalReturn)
	assert.False(t, w.HasStrategyOverlapCagr)
}
