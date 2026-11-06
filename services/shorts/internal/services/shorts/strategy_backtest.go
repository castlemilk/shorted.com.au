package shorts

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata" // the Sydney run date needs the zone without the host's tz database

	"cloud.google.com/go/civil"
	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/backtest"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// The backtest rpcs (PR-18). The public reads (GetBacktestRun, ListStrategyEvidence) serve canonical
// runs only and are caller-invariant: no caller's claims reach them, and they are cached per instance
// for strategyCacheTTL. The private reads (ListBacktestTrades, CompareStrategies) need a signed-in
// caller; canonical runs are shared, so their ids are resolved under no owner.

// benchmarkName is the benchmark every run is measured against (5.7).
const benchmarkName = "S&P/ASX 200 Gross Total Return (XJT)"

// backtestWindowStart is the first canonical session: 2019-05-01, the first full month of XJT.
const backtestWindowStart = "2019-05-01"

// The states a strategy's backtest can be in (8.2, 1.7).
const (
	backtestStatePublished     = "published"
	backtestStateApproximate   = "approximate"
	backtestStateRunRequired   = "run_required"
	backtestStateRunning       = "running"
	backtestStateNotComputable = "not_computable"
)

// The window ids the API serves (8.2). The backtest package names its windows differently; specWindow
// maps them.
const (
	windowSince2019  = "since_2019_05"
	windowSince2023  = "since_2023"
	windowTrailing12 = "trailing_12m"
	windowLive       = "live"
)

// consolidationNote is the 5.11 note on pre-re-sync consolidations, served with every run: the
// Crowded-Short ranking reads days to cover over the ASIC share history.
const consolidationNote = "Pre-re-sync consolidations (an ASIC share step of 1.8x or more with a continuous vendor price): days to cover before them is overstated by the factor. It is a non-core ranking input for Crowded-Short, and no decision uses the later step."

// sydney is the zone a run's date is stated in.
var sydney = func() *time.Location {
	loc, err := time.LoadLocation("Australia/Sydney")
	if err != nil {
		return time.FixedZone("AEST", 10*3600)
	}
	return loc
}()

// specWindow maps the backtest package's window id to the id 8.2 names.
func specWindow(pkgID string) string {
	switch pkgID {
	case backtest.WindowSinceMay2019:
		return windowSince2019
	case backtest.WindowSince2023:
		return windowSince2023
	case backtest.WindowLast12Months:
		return windowTrailing12
	case backtest.WindowLiveSinceFreeze:
		return windowLive
	}
	return pkgID
}

// packageWindow maps 8.2's window id to the backtest package's.
func packageWindow(specID string) (string, bool) {
	switch specID {
	case windowSince2019:
		return backtest.WindowSinceMay2019, true
	case windowSince2023:
		return backtest.WindowSince2023, true
	case windowTrailing12:
		return backtest.WindowLast12Months, true
	case windowLive:
		return backtest.WindowLiveSinceFreeze, true
	}
	return "", false
}

// specMeasurement maps the stored survivorship measurement to 8.2's values: measured | partial |
// not_measurable. An ASIC-reported-only run (Minervini) is partial.
func specMeasurement(stored string) string {
	switch stored {
	case backtest.MeasurementASICOnly:
		return "partial"
	case backtest.MeasurementNotMeasurable:
		return "not_measurable"
	}
	return "measured"
}

// liveBacktest is a strategy's live canonical version and recipe, as the backtests key them.
type liveBacktest struct {
	strategyID string
	table      versionTable
	reg        spec.Registered
	found      bool
	hash       string
	recipe     *spec.Recipe
	recipeHash string
}

// liveBacktestOf resolves a strategy's live version: the version table's live row, or the registry's
// live flag when the table has none.
func (s *ShortsServer) liveBacktestOf(ctx context.Context, strategyID string) (liveBacktest, error) {
	t, err := s.readVersionTable(ctx)
	if err != nil {
		return liveBacktest{}, err
	}
	lb := liveBacktest{strategyID: strategyID, table: t, hash: t.liveRulesHash(strategyID)}
	if r, ok := spec.ByHash(lb.hash); ok && r.Spec.StrategyID == strategyID {
		lb.reg, lb.found = r, true
	} else if r, ok := spec.Live(strategyID); ok {
		lb.reg, lb.found = r, true
		if h, err := spec.RulesHash(r.Spec); err == nil {
			lb.hash = h
		}
	}
	if lb.found && lb.reg.Recipe != nil {
		lb.recipe = lb.reg.Recipe
		h, err := spec.RecipeHash(*lb.recipe)
		if err != nil {
			return liveBacktest{}, err
		}
		lb.recipeHash = h
	}
	return lb, nil
}

// shortRules names the live rules for copy: its label and the first eight hash characters.
func (lb liveBacktest) shortRules() string {
	hash := lb.hash
	if len(hash) > 8 {
		hash = hash[:8]
	}
	return fmt.Sprintf("%s %s", lb.reg.Label, hash)
}

// backtestState is where a strategy's live backtest stands, with the row it reads from.
type backtestState struct {
	state        string
	reason       string
	computed     *shortsstore.BacktestRunRow
	notComputed  *shortsstore.BacktestRunRow
	runningSince time.Time
}

// backtestStateOf reads the state of a strategy's live backtest, in this order: a published run; a
// not-computable outcome (checked before running, so a running request never hides it); a running
// request; otherwise run_required. A live version with no recipe is run_required with its reason, not
// not_computable: the fundamentals copy is not true of it. A missing table reads as no run yet.
func (s *ShortsServer) backtestStateOf(ctx context.Context, lb liveBacktest) (backtestState, error) {
	if !lb.found {
		return backtestState{state: backtestStateRunRequired, reason: "No live rules version is registered for this strategy."}, nil
	}
	if lb.recipe == nil {
		return backtestState{state: backtestStateRunRequired, reason: fmt.Sprintf("The live rules (%s) have no backtest recipe yet, so no backtest is computed for them.", lb.shortRules())}, nil
	}
	st := s.strategyBacktests
	if st == nil {
		return backtestState{state: backtestStateRunRequired, reason: runRequiredReason(lb)}, nil
	}
	row, ok, err := st.ReadPublishedBacktest(ctx, lb.strategyID, lb.hash, lb.recipeHash)
	if err != nil && !errors.Is(err, shortsstore.ErrStrategyBacktestSchema) {
		return backtestState{}, err
	}
	if ok {
		return backtestState{state: backtestStatePublished, computed: &row}, nil
	}
	nc, ok, err := st.ReadNotComputableBacktest(ctx, lb.strategyID, lb.hash, lb.recipeHash)
	if err != nil && !errors.Is(err, shortsstore.ErrStrategyBacktestSchema) {
		return backtestState{}, err
	}
	if ok {
		return backtestState{state: backtestStateNotComputable, reason: notComputableReason(nc), notComputed: &nc}, nil
	}
	since, running, err := st.ReadRunningBacktest(ctx, lb.strategyID, lb.hash, lb.recipeHash)
	if err != nil && !errors.Is(err, shortsstore.ErrStrategyBacktestSchema) {
		return backtestState{}, err
	}
	if running {
		return backtestState{state: backtestStateRunning, reason: "A backtest of the live rules is running.", runningSince: since}, nil
	}
	return backtestState{state: backtestStateRunRequired, reason: runRequiredReason(lb)}, nil
}

// runRequiredReason is the copy for a live version with a recipe and no published run (1.7).
func runRequiredReason(lb liveBacktest) string {
	return fmt.Sprintf("No completed backtest for rules %s yet. It is queued; results usually appear within the hour.", lb.shortRules())
}

// notComputableReason is the copy of a not-computable outcome (1.7): with the measured fiscal label, or
// with the measured universe share when no label was reached.
func notComputableReason(row shortsstore.BacktestRunRow) string {
	if row.FiscalLabel != "" {
		return fmt.Sprintf("Not computable before %s. From %s a test is possible only by assuming when results were known and using restated figures; it is not published.", row.FiscalLabel, row.FiscalLabel)
	}
	if share, ok := summaryShare(row.Summary); ok {
		return fmt.Sprintf("Not computable: needs point-in-time fundamentals (fundamentals for %.0f%% of the universe)", share*100)
	}
	return "Not computable: needs point-in-time fundamentals"
}

// summaryShare is the measured universe share of a not-computable outcome, when the row carries one.
func summaryShare(summary []byte) (float64, bool) {
	var sum storedSummary
	if json.Unmarshal(summary, &sum) != nil || sum.Share == nil {
		return 0, false
	}
	return *sum.Share, true
}

// cachedBacktest caches a fill for strategyCacheTTL. The fill runs on a context that outlives the
// caller (a cache fill must not be cancelled by one caller), reads no claims, and an error is never
// stored, so a failed read is retried by the next caller.
func (s *ShortsServer) cachedBacktest(key string, fill func() (any, error)) (any, error) {
	if s.cache == nil {
		return fill()
	}
	return s.cache.GetOrSetWithTTL(key, strategyCacheTTL, fill)
}

// storedSummary is a run's summary document. The job marshals the backtest package's own types, which
// carry no JSON tags, so each field decodes by its Go name; DiffNote is tagged in the package.
type storedSummary struct {
	State        string                 `json:"state"`
	Coverage     backtest.Coverage      `json:"coverage"`
	Survivorship backtest.Survivorship  `json:"survivorship"`
	DataQuality  backtest.DataQuality   `json:"data_quality"`
	Sensitivity  backtest.Sensitivities `json:"sensitivity"`
	Reference    backtest.WindowFigures `json:"reference"`
	Trades       backtest.TradeSummary  `json:"trades"`
	Diff         backtest.DiffNote      `json:"diff"`
	Share        *float64               `json:"share"`
}

// storedRun is one publishable run's stored parts: its row, its series, its summary and its trades.
// A stored run never changes, so it is cached per run id; the paper track is read per request.
type storedRun struct {
	row     shortsstore.BacktestRunRow
	series  storedSeries
	summary storedSummary
	trades  []shortsstore.BacktestTradeRow
}

// loadStoredRun reads a run's stored parts, cached per run id.
func (s *ShortsServer) loadStoredRun(ctx context.Context, row shortsstore.BacktestRunRow) (*storedRun, error) {
	v, err := s.cachedBacktest(fmt.Sprintf("backtest_stored:%d", row.ID), func() (any, error) {
		return s.readStoredRun(context.WithoutCancel(ctx), row)
	})
	if err != nil {
		return nil, err
	}
	return v.(*storedRun), nil
}

// readStoredRun decodes a run's series, summary and trades. A publishable run with no series is an error:
// its figures cannot be served.
func (s *ShortsServer) readStoredRun(ctx context.Context, row shortsstore.BacktestRunRow) (*storedRun, error) {
	st := s.strategyBacktests
	raw, err := st.ReadBacktestSeries(ctx, row.ID)
	if err != nil {
		return nil, err
	}
	if raw == nil {
		return nil, fmt.Errorf("backtest run %d has no series", row.ID)
	}
	out := &storedRun{row: row}
	if err := json.Unmarshal(raw, &out.series); err != nil {
		return nil, fmt.Errorf("backtest run %d: decode the series: %w", row.ID, err)
	}
	if err := json.Unmarshal(row.Summary, &out.summary); err != nil {
		return nil, fmt.Errorf("backtest run %d: decode the summary: %w", row.ID, err)
	}
	out.trades, err = st.ReadBacktestTrades(ctx, row.ID)
	if err != nil && !errors.Is(err, shortsstore.ErrStrategyBacktestSchema) {
		return nil, err
	}
	return out, nil
}

// paperTrack is a key's recorded paper track: its equity and trades, read once per request.
type paperTrack struct {
	since  string
	equity []shortsstore.PaperEquityRow
	trades []shortsstore.PaperTradeRow
}

// readPaperTrack reads a key's paper track. A missing paper schema, or no recipe, is an empty track.
func (s *ShortsServer) readPaperTrack(ctx context.Context, rules, recipe, since string) (paperTrack, error) {
	pt := paperTrack{since: since}
	if s.strategyBacktests == nil || recipe == "" {
		return pt, nil
	}
	eq, err := s.strategyBacktests.ReadPaperEquity(ctx, rules, recipe)
	if err != nil && !errors.Is(err, shortsstore.ErrStrategyBacktestSchema) {
		return paperTrack{}, err
	}
	trades, err := s.strategyBacktests.ReadPaperTrades(ctx, rules, recipe)
	if err != nil && !errors.Is(err, shortsstore.ErrStrategyBacktestSchema) {
		return paperTrack{}, err
	}
	pt.equity, pt.trades = eq, trades
	return pt, nil
}

// sinceOf is a version's live_from from the table, "" when the table has none.
func (lb liveBacktest) sinceOf(rules string) string {
	if row, ok := lb.table.rows[rules]; ok {
		return row.LiveFrom
	}
	return ""
}

// computedRun is a publishable run assembled with its paper track: the chained curve, the package's
// window figures, and the cash rate the Sharpe ratio reads.
type computedRun struct {
	stored *storedRun
	chain  chainedRun
	paper  paperTrack
	figs   []backtest.WindowFigures
}

// assembleRun chains a run with its paper track and measures its windows.
func (s *ShortsServer) assembleRun(ctx context.Context, sr *storedRun, pt paperTrack) (*computedRun, error) {
	chain, err := buildChainedRun(sr.series, sr.row.InSampleUntil, pt.equity)
	if err != nil {
		return nil, fmt.Errorf("backtest run %d: %w", sr.row.ID, err)
	}
	latest := chain.days[len(chain.days)-1].date
	cash, err := s.strategyBacktests.ReadCashRate(ctx, latest)
	if err != nil {
		// Without the cash series the Sharpe ratio has no risk-free rate, which the identity states.
		s.logger.Warnf("backtest run %d: the cash rate is unavailable, the Sharpe ratio has no risk-free rate: %v", sr.row.ID, err)
		cash = nil
	}
	figs, err := backtest.Windows(chain.bt, chain.paper, chain.liveFrom, cash)
	if err != nil {
		return nil, fmt.Errorf("backtest run %d: %w", sr.row.ID, err)
	}
	return &computedRun{stored: sr, chain: chain, paper: pt, figs: figs}, nil
}

// spanOf is the sessions of one window the run serves: the window's own sessions, from its first to its
// last session, drawn from the chained curve.
func (c *computedRun) spanOf(f backtest.WindowFigures) []chainDay {
	return daysBetween(c.chain.days, f.Start, f.End)
}

// windowTrades is the trades the figures of a window count (5.9).
func (c *computedRun) windowTrades() []windowTrade {
	return windowTradesFor(c.stored.trades, c.paper.trades, c.chain.liveFrom, c.chain.hasLive, c.chain.paper != nil)
}

// windowMetrics maps one window's figures onto the wire, with the trade, exposure, benchmark and
// reference figures the package does not carry, and the drawdown's dates.
func windowMetrics(f backtest.WindowFigures, days []chainDay, trades []windowTrade) *shortsv1alpha1.WindowMetrics {
	m := &shortsv1alpha1.WindowMetrics{
		Window:         specWindow(f.ID),
		From:           f.Start.String(),
		To:             f.End.String(),
		TotalReturnPct: round2(f.TotalReturn * 100),
		HasTotalReturn: f.HasTotalReturn,
		CagrPct:        round2(f.CAGR * 100),
		HasCagr:        f.HasCAGR,
		MaxDrawdownPct: round2(f.MaxDrawdown.Depth * 100),
		Sharpe:         round2(f.Sharpe.Annual),
		SharpeSe:       round2(f.Sharpe.SE),
		HasSharpe:      f.Sharpe.Shown,
		Label:          f.Label,
		Note:           f.Note,
		NotAnnualised:  f.NotAnnualised,
		Sessions:       int32(f.Sessions),
		CalendarDays:   int32(f.CalendarDays),
		VolatilityPct:  round2(f.Volatility * 100),
		HasVolatility:  f.HasVolatility,
		PeakDate:       dateAt(days, f.MaxDrawdown.Peak),
		TroughDate:     dateAt(days, f.MaxDrawdown.Trough),
		RecoveryDate:   recoveryDate(days, f.MaxDrawdown),
	}
	var exposure float64
	recorded := false
	allBench, allRef := len(days) > 0, len(days) > 0
	for _, d := range days {
		exposure += d.exposure
		recorded = recorded || d.recorded
		allBench = allBench && d.hasBench
		allRef = allRef && d.hasRef
	}
	if len(days) > 0 {
		m.ExposurePct = round2(exposure / float64(len(days)) * 100)
	}
	m.RecordedTail = recorded
	if allBench {
		if cagr, ok := backtest.CAGR(curveOfField(days, func(d chainDay) float64 { return d.bench })); ok {
			m.BenchmarkCagrPct, m.HasBenchmark = round2(cagr*100), true
		}
		m.BenchmarkTotalReturnPct = round2((days[len(days)-1].bench/days[0].bench - 1) * 100)
		m.HasBenchmarkTotalReturn = true
	}
	if allRef {
		if cagr, ok := backtest.CAGR(curveOfField(days, func(d chainDay) float64 { return d.ref })); ok {
			m.ReferenceCagrPct, m.HasReference = round2(cagr*100), true
		}
		m.ReferenceTotalReturnPct = round2((days[len(days)-1].ref/days[0].ref - 1) * 100)
		m.HasReferenceTotalReturn = true
	}
	closed, win, hasWin := closedAndWinRate(trades, f.Start, f.End)
	m.ClosedTrades = int32(closed)
	m.WinRatePct, m.HasWinRate = round2(win), hasWin
	return m
}

// paperStart is the paper track's actual first recorded session, "" when no track chains.
func (c *computedRun) paperStart() string {
	if !c.chain.hasPaper {
		return ""
	}
	return c.chain.startAt.String()
}

// windowNote is the note a window carries (item 7). Before the paper track starts, the window is in-sample
// to the day before live_from. Once a track chains, the windows that span it say so, and name the track's
// actual first session when that is after live_from. The live window is the track alone.
func (c *computedRun) windowNote(windowID string) string {
	if windowID == windowLive {
		if c.chain.hasPaper {
			return fmt.Sprintf("paper track only, recorded from %s", c.chain.startAt)
		}
		return "paper track only, recorded"
	}
	switch {
	case c.chain.hasPaper && c.chain.startAt.After(c.chain.frozenAt):
		return fmt.Sprintf("in-sample to %s, recorded from %s", c.chain.frozenAt, c.chain.startAt)
	case c.chain.hasPaper:
		return fmt.Sprintf("in-sample to %s, recorded after", c.chain.frozenAt.AddDays(-1))
	case c.chain.hasLive:
		return fmt.Sprintf("in-sample to %s", c.chain.frozenAt.AddDays(-1))
	}
	return ""
}

// applyWindowNotes sets each window's note from the run's paper track.
func applyWindowNotes(wins []*shortsv1alpha1.WindowMetrics, c *computedRun) {
	for _, w := range wins {
		w.Note = c.windowNote(w.GetWindow())
	}
}

// applyReferenceFallback gives the since-May-2019 window the reference figures the summary states, when
// its daily series carries no reference (runs published before the reference was written into the
// records). The summary's figures are the whole run's, which is the since-2019 window; the other windows
// have no daily reference and keep none.
func applyReferenceFallback(wins []*shortsv1alpha1.WindowMetrics, days []chainDay, sum storedSummary) {
	if len(days) == 0 || days[0].hasRef || !sum.Reference.HasTotalReturn {
		return
	}
	for _, w := range wins {
		if w.GetWindow() != windowSince2019 || w.GetHasReferenceTotalReturn() {
			continue
		}
		w.ReferenceTotalReturnPct, w.HasReferenceTotalReturn = round2(sum.Reference.TotalReturn*100), true
		if sum.Reference.HasCAGR {
			w.ReferenceCagrPct, w.HasReference = round2(sum.Reference.CAGR*100), true
		}
	}
}

// dateAt is the session at index k of days, "" when k is outside it.
func dateAt(days []chainDay, k int) string {
	if k < 0 || k >= len(days) {
		return ""
	}
	return days[k].date.String()
}

// recoveryDate is the first session back at the peak. A curve that fell and has not recovered says so;
// one that never fell has none.
func recoveryDate(days []chainDay, d backtest.Drawdown) string {
	if d.Trough < 0 {
		return ""
	}
	if d.Recovery < 0 {
		return "not recovered"
	}
	return dateAt(days, d.Recovery)
}

// curveOfField is a span's curve of one series.
func curveOfField(days []chainDay, field func(chainDay) float64) backtest.Curve {
	c := backtest.Curve{Dates: make([]civil.Date, 0, len(days)), Values: make([]float64, 0, len(days))}
	for _, d := range days {
		c.Dates = append(c.Dates, d.date)
		c.Values = append(c.Values, field(d))
	}
	return c
}

// daysBetween is the chained sessions from `from` to `to`, both inclusive.
func daysBetween(days []chainDay, from, to civil.Date) []chainDay {
	lo := sort.Search(len(days), func(k int) bool { return !days[k].date.Before(from) })
	hi := sort.Search(len(days), func(k int) bool { return days[k].date.After(to) })
	if lo >= hi {
		return nil
	}
	return days[lo:hi]
}

// servedSeries is the series a request gets: the chosen window's sessions, decimated to daily when
// they are at most weeklyPointCap, and to weekly otherwise.
type servedSeries struct {
	windowID   string
	window     *backtest.WindowFigures
	days       []chainDay
	points     []*shortsv1alpha1.SeriesPoint
	resolution string
}

// serveSeries picks the window and the resolution. daily is served only when the window fits the cap;
// otherwise the answer is weekly and series_resolution says so. The weekly points keep the window's own
// peak and trough, and the sessions either side of live_from, so the drawn fall reaches the reported
// maximum.
func (c *computedRun) serveSeries(specID, resolution string) servedSeries {
	pkgID, ok := packageWindow(specID)
	if !ok {
		return servedSeries{}
	}
	var fig *backtest.WindowFigures
	for i := range c.figs {
		if c.figs[i].ID == pkgID {
			fig = &c.figs[i]
		}
	}
	if fig == nil {
		return servedSeries{windowID: specID}
	}
	days := c.spanOf(*fig)
	out := servedSeries{windowID: specID, window: fig, days: days}
	if resolution == "daily" && len(days) <= weeklyPointCap {
		idx := make([]int, len(days))
		for k := range idx {
			idx[k] = k
		}
		out.points, out.resolution = seriesOf(days, idx), "daily"
		return out
	}
	var must []int
	if fig.MaxDrawdown.Peak >= 0 {
		must = append(must, fig.MaxDrawdown.Peak)
	}
	if fig.MaxDrawdown.Trough >= 0 {
		must = append(must, fig.MaxDrawdown.Trough)
	}
	if c.chain.hasLive {
		k := sort.Search(len(days), func(k int) bool { return !days[k].date.Before(c.chain.liveFrom) })
		must = append(must, k, k-1)
	}
	out.points, out.resolution = seriesOf(days, keptSessions(days, must)), "weekly"
	return out
}

// coverageRows are both measures by year and by month. A year or month a measure does not carry reads as
// not measurable, not zero. The per-year exit counts come from the trades that exited in the year.
func coverageRows(cov backtest.Coverage, trades []shortsstore.BacktestTradeRow) ([]*shortsv1alpha1.CoverageYear, []*shortsv1alpha1.CoverageMonth) {
	type pair struct{ q, a *backtest.CoveragePeriod }
	years := map[string]*pair{}
	months := map[string]*pair{}
	add := func(m map[string]*pair, p backtest.CoveragePeriod, qual bool) {
		e := m[p.Period]
		if e == nil {
			e = &pair{}
			m[p.Period] = e
		}
		c := p
		if qual {
			e.q = &c
		} else {
			e.a = &c
		}
	}
	for _, p := range cov.Qualifying.Years {
		add(years, p, true)
	}
	for _, p := range cov.AllReported.Years {
		add(years, p, false)
	}
	for _, p := range cov.Qualifying.Months {
		add(months, p, true)
	}
	for _, p := range cov.AllReported.Months {
		add(months, p, false)
	}
	delisted, cas := map[int]int32{}, map[int]int32{}
	for _, t := range trades {
		if t.Open || t.ExitDate == "" {
			continue
		}
		exit, err := civil.ParseDate(t.ExitDate)
		if err != nil {
			continue
		}
		switch t.ExitReason {
		case backtest.ReasonDelisted:
			delisted[exit.Year]++
		case backtest.ReasonCorporateAction:
			cas[exit.Year]++
		}
	}
	var outY []*shortsv1alpha1.CoverageYear
	for _, k := range sortedPairKeys(years) {
		e := years[k]
		y, _ := strconv.Atoi(k)
		row := &shortsv1alpha1.CoverageYear{Year: int32(y), DelistingExits: delisted[y], CaExits: cas[y]}
		row.Measurable, row.QualifyingNameDays, row.PricedNameDays, row.CoveragePct = measureOf(e.q)
		row.AllReportedMeasurable, row.AllReportedNameDays, row.AllReportedPricedNameDays, row.AllReportedPct = measureOf(e.a)
		outY = append(outY, row)
	}
	var outM []*shortsv1alpha1.CoverageMonth
	for _, k := range sortedPairKeys(months) {
		e := months[k]
		row := &shortsv1alpha1.CoverageMonth{Month: k}
		row.Measurable, _, _, row.CoveragePct = measureOf(e.q)
		row.AllReportedMeasurable, _, _, row.AllReportedPct = measureOf(e.a)
		outM = append(outM, row)
	}
	return outY, outM
}

// measureOf is one measure's period: whether it is measurable, its name-days, its priced name-days and the
// ratio in percent. A measure with no name-days is not measurable and its ratio is zero.
func measureOf(p *backtest.CoveragePeriod) (measurable bool, names, priced int64, pct float64) {
	if p == nil {
		return false, 0, 0, 0
	}
	names, priced = int64(p.Qualifying), int64(p.Priced)
	if p.Qualifying > 0 {
		return true, names, priced, round2(p.Ratio * 100)
	}
	return false, names, priced, 0
}

// sortedPairKeys is the keys of a period map in order.
func sortedPairKeys[T any](m map[string]T) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// sensitivitiesOf maps the run's sensitivity runs. A fragility flag names its chip.
func sensitivitiesOf(sum backtest.Sensitivities) []*shortsv1alpha1.Sensitivity {
	out := make([]*shortsv1alpha1.Sensitivity, 0, len(sum.Runs))
	for _, r := range sum.Runs {
		out = append(out, &shortsv1alpha1.Sensitivity{
			Id:                   r.ID,
			Label:                r.Label,
			CagrPct:              round2(r.Figures.CAGR * 100),
			HasCagr:              r.Figures.HasCAGR,
			ExcessVsBenchmarkPct: round2(r.Figures.Excess * 100),
			HasExcess:            r.Figures.HasExcess,
			MaxDrawdownPct:       round2(r.Figures.MaxDrawdown * 100),
			Fragile:              r.Fragile != "",
			FragileChip:          backtest.FragileChip(r.Fragile),
			Applies:              r.Applies,
			Reason:               r.Reason,
		})
	}
	return out
}

// diffNoteOf is the diff note's copy: the codes whose price rows changed since the previous run, the ASIC
// product codes revised, and the CAGR shift they caused. "" when there is no previous run to compare with.
func diffNoteOf(d backtest.DiffNote) string {
	var parts []string
	if d.RewrittenCount > 0 {
		parts = append(parts, fmt.Sprintf("%d codes' price rows rewritten since the previous run", d.RewrittenCount))
	}
	if d.RevisedCount > 0 {
		parts = append(parts, fmt.Sprintf("%d ASIC product codes revised in reports the previous run read", d.RevisedCount))
	}
	if d.HasCAGRShift {
		parts = append(parts, fmt.Sprintf("CAGR moved %+.1f pp over the shared window", d.CAGRShiftPP))
	}
	if len(parts) > 0 {
		return strings.Join(parts, "; ") + "."
	}
	if d.State == "unchanged" {
		return "Inputs unchanged since the previous run."
	}
	return ""
}

// recipeByHash is the registered r1 recipe with the hash, when one is registered.
func recipeByHash(hash string) (spec.Recipe, bool) {
	for _, r := range spec.R1Recipes() {
		if h, err := spec.RecipeHash(r); err == nil && h == hash {
			return r, true
		}
	}
	return spec.Recipe{}, false
}

// referenceName names the recipe's reference universe (1.8 item 7).
func referenceName(r spec.Recipe) string {
	if r.Reference == spec.ReferenceCrowdedShorts {
		return "Same-data reference: liquid crowded shorts, equal weight"
	}
	return "Same-data reference: liquid ordinary shares, equal weight"
}

// recipeLinesOf renders the recipe's prose, preface first. A recipe that does not render has no lines.
func recipeLinesOf(r spec.Recipe) *shortsv1alpha1.RecipeLines {
	lines, err := spec.RenderRecipeLines(r)
	if err != nil {
		return nil
	}
	return &shortsv1alpha1.RecipeLines{
		RecipeId: lines.RecipeID, Entry: lines.Entry, Exits: lines.Exits, Sizing: lines.Sizing,
		Brokerage: lines.Brokerage, Spread: lines.Spread, Capacity: lines.Capacity,
		Dividends: lines.Dividends, AsicData: lines.ASICData, Delisting: lines.Delisting,
		Capital: lines.Capital, Cash: lines.Cash, Preface: lines.Preface,
	}
}

// disclosuresOf is the copy every run prints beside its figures (1.8), verbatim where the spec fixes it.
func disclosuresOf(inSampleUntil, liveFrom, caveat string) []string {
	out := []string{
		"Hypothetical results from rules applied to historical data, not a record of trading. Not financial advice.",
		"Total return: dividends as adjusted by the price vendor, or credited in cash on the ex-date from ASX dividend notices where the vendor has not adjusted them (notices from 11 Sep 2024); franking excluded; vs S&P/ASX 200 Gross Total Return.",
		"ASIC basis: Latest complete ASIC report published by each session (T+4 sessions on a calendar derived from the data; assumed for the whole history); values as later revised; original publications not kept.",
		"Reference: The reference is built from the same price history with the same gaps. If a strategy beats the ASX 200 but not the reference, the edge may be the data rather than the rules. Gaps are uneven across stocks, so subtracting the reference does not remove survivorship bias.",
		"Survivorship: Prices are missing for companies that delisted before about 2025. Heavily shorted companies that later failed are over-represented among them, so these results flatter the strategy, most in the earlier years; by how much cannot be measured.",
	}
	if caveat != "" {
		out = append(out, caveat)
	}
	if inSampleUntil != "" {
		out = append(out, fmt.Sprintf("In-sample · rules frozen %s: the figures to %s are in-sample; the recorded paper track follows.", liveFrom, inSampleUntil))
	}
	return out
}

// dataNotesOf names the counts a run excluded or could not price, as prose (5.11).
func dataNotesOf(dq backtest.DataQuality) []string {
	var out []string
	if dq.DelistingExits > 0 {
		out = append(out, fmt.Sprintf("%d positions exited at their last close after a delisting.", dq.DelistingExits))
	}
	if dq.CorporateActionExit > 0 {
		out = append(out, fmt.Sprintf("%d positions exited on a corporate action.", dq.CorporateActionExit))
	}
	if dq.FallbackClose > 0 {
		out = append(out, fmt.Sprintf("%d held bars fell back to a close price.", dq.FallbackClose))
	}
	if dq.PriceReturnTrades > 0 {
		out = append(out, fmt.Sprintf("%d trades carry price return only at a held bar.", dq.PriceReturnTrades))
	}
	return append(out, consolidationNote)
}

// dataQualityOf serves every count a run stores, as fields, with the consolidation note.
func dataQualityOf(dq backtest.DataQuality) *shortsv1alpha1.DataQuality {
	out := &shortsv1alpha1.DataQuality{
		DelistingExits:       int32(dq.DelistingExits),
		CorporateActionExits: int32(dq.CorporateActionExit),
		CaSuspects:           int32(dq.CASuspects),
		FallbackClose:        int32(dq.FallbackClose),
		PriceReturnTrades:    int32(dq.PriceReturnTrades),
		CapacityCapped:       int32(dq.CapacityCapped),
		StaleMarkTrades:      int32(dq.StaleMarkTrades),
		DelayedExits:         int32(dq.DelayedExits),
		DividendsCredited:    int32(dq.DividendsCredited),
		ConsolidationNote:    consolidationNote,
		CancelledEntries:     map[string]int32{},
	}
	for k, v := range dq.CancelledEntries {
		out.CancelledEntries[k] = int32(v)
	}
	return out
}

// versionRefFor is the wire reference of a stored rules hash, with its state from the table.
func versionRefFor(t versionTable, hash string) *shortsv1alpha1.StrategyVersionRef {
	r, ok := spec.ByHash(hash)
	if !ok {
		return nil
	}
	return versionRefWith(r, hash, t.stateOf(r, hash))
}

// recipeIDOf is the registered recipe's id for a hash, "" when none matches.
func recipeIDOf(hash string) string {
	if r, ok := recipeByHash(hash); ok {
		return r.ID
	}
	return ""
}

// runIdentityOf is a run's identity. The run date is the Sydney date the run finished on.
func runIdentityOf(sr *storedRun, lb liveBacktest) *shortsv1alpha1.BacktestRunIdentity {
	row := sr.row
	risk := "none"
	if row.Fundamentals != "" {
		risk = "RBA cash rate"
	}
	ref := ""
	if r, ok := recipeByHash(row.RecipeHash); ok {
		ref = referenceName(r)
	}
	finished := row.FinishedAt.UTC()
	return &shortsv1alpha1.BacktestRunIdentity{
		RunId:             row.ID,
		RunKey:            row.RunKey,
		Kind:              row.Kind,
		Version:           versionRefFor(lb.table, row.RulesHash),
		RecipeId:          recipeIDOf(row.RecipeHash),
		RecipeHash:        row.RecipeHash,
		EngineVersion:     row.EngineVersion,
		WindowStart:       row.WindowStart,
		WindowEnd:         row.WindowEnd,
		Returns:           "total",
		Benchmark:         "XJT",
		Fundamentals:      row.Fundamentals,
		PricesThrough:     row.PricesThrough,
		AsicReportThrough: row.ASICThrough,
		InSampleUntil:     row.InSampleUntil,
		FinishedAt:        finished.Format(time.RFC3339),
		InputHash:         row.InputHash,
		OutputHash:        row.OutputHash,
		BuildRevision:     row.BuildRevision,
		RiskFree:          risk,
		ReferenceName:     ref,
		RunDate:           finished.In(sydney).Format("2006-01-02"),
	}
}

// fundamentalsLabel is the fundamentals policy in words the surfaces print (1.7, 5.15).
func fundamentalsLabel(policy string) string {
	if policy == spec.FundamentalsApprox {
		return "Approximate: fundamentals assumed known 2 months after period end; restated vendor values; only companies still listed in September 2026 have fundamentals, which flatters results"
	}
	return "Point-in-time fundamentals from the capture date (strict policy)"
}

// survivorshipOf is the survivorship block of a run, with 8.2's measurement value.
func survivorshipOf(sum storedSummary) *shortsv1alpha1.Survivorship {
	s := sum.Survivorship
	return &shortsv1alpha1.Survivorship{
		Measurement: specMeasurement(s.Measurement),
		Direction:   s.Direction,
		Statement:   s.Copy,
		Caveat:      s.Caveat,
	}
}

// runFromStored builds a publishable run's full answer for one window and resolution.
func (s *ShortsServer) runFromStored(ctx context.Context, lb liveBacktest, sr *storedRun, pt paperTrack, specWin, resolution string) (*shortsv1alpha1.BacktestRun, error) {
	c, err := s.assembleRun(ctx, sr, pt)
	if err != nil {
		return nil, err
	}
	wins := make([]*shortsv1alpha1.WindowMetrics, 0, len(c.figs))
	for _, f := range c.figs {
		wins = append(wins, windowMetrics(f, c.spanOf(f), c.windowTrades()))
	}
	applyReferenceFallback(wins, c.chain.days, sr.summary)
	applyWindowNotes(wins, c)
	served := c.serveSeries(specWin, resolution)
	annual, monthly := periodTables(c.chain.days, sr.summary.Coverage, sr.summary.Survivorship.Measurement)
	covYears, covMonths := coverageRows(sr.summary.Coverage, sr.trades)

	// The in-sample trades are the ones that exited before live_from (1.5); the paper track counts in
	// the windows, not here.
	inSample := inSampleTrades(sr.trades, c.chain.liveFrom, c.chain.hasLive)

	state, reason := backtestStatePublished, ""
	if sr.row.Fundamentals != spec.FundamentalsStrict {
		state, reason = backtestStateApproximate, "Approximate: fundamentals assumed known 2 months after period end"
	}
	run := &shortsv1alpha1.BacktestRun{
		State:               state,
		StateReason:         reason,
		StrategyId:          sr.row.StrategyID,
		Identity:            runIdentityOf(sr, lb),
		Windows:             wins,
		Annual:              annual,
		Monthly:             monthly,
		Series:              served.points,
		Coverage:            covYears,
		CoverageMonthly:     covMonths,
		Survivorship:        survivorshipOf(sr.summary),
		Sensitivity:         sensitivitiesOf(sr.summary.Sensitivity),
		Recipe:              recipeLinesOfHash(sr.row.RecipeHash),
		TradeSummary:        tradeSummaryOf(inSample),
		LiveVersion:         versionRefWith(lb.reg, lb.hash, lb.table.stateOf(lb.reg, lb.hash)),
		RulesMatchLive:      lb.found && sr.row.RulesHash == lb.hash && sr.row.RecipeHash == lb.recipeHash,
		EngineMatchesLive:   sr.row.EngineVersion == engine.Version,
		ReplayAgreement:     s.replayFor(c, lb),
		InputChangeNote:     diffNoteOf(sr.summary.Diff),
		Disclosures:         disclosuresOf(sr.row.InSampleUntil, c.chain.liveFromString(), sr.summary.Survivorship.Caveat),
		DataNotes:           dataNotesOf(sr.summary.DataQuality),
		DataQuality:         dataQualityOf(sr.summary.DataQuality),
		SeriesResolution:    served.resolution,
		WindowId:            served.windowID,
		FundamentalsLabel:   fundamentalsLabel(sr.row.Fundamentals),
		PaperStart:          c.paperStart(),
		PaperEngineSegments: engineSegmentsOf(pt.equity),
	}
	return run, nil
}

// inSampleTrades are the trades that entered before live_from and did not exit on or after it: the
// in-sample record the trade summary states (1.5). A trade entered on or after the freeze is the paper
// track's, whether it is still open or not.
func inSampleTrades(trades []shortsstore.BacktestTradeRow, liveFrom civil.Date, hasLive bool) []shortsstore.BacktestTradeRow {
	if !hasLive {
		return trades
	}
	var out []shortsstore.BacktestTradeRow
	for _, t := range trades {
		entry, err := civil.ParseDate(t.EntryDate)
		if err != nil || !entry.Before(liveFrom) {
			continue
		}
		if t.ExitDate != "" {
			if exit, err := civil.ParseDate(t.ExitDate); err == nil && !exit.Before(liveFrom) {
				continue
			}
		}
		out = append(out, t)
	}
	return out
}

// recipeLinesOfHash is the recipe prose of a stored recipe hash, nil when no registered recipe matches.
func recipeLinesOfHash(hash string) *shortsv1alpha1.RecipeLines {
	r, ok := recipeByHash(hash)
	if !ok {
		return nil
	}
	return recipeLinesOf(r)
}

// liveFromString is the chain's live_from as a date, "" for a run with no live split.
func (c chainedRun) liveFromString() string {
	if !c.hasLive {
		return ""
	}
	return c.liveFrom.String()
}

// replayFor is the replay line of a run (5.13). A run whose fundamentals policy is not the live recipe's
// is not compared.
func (s *ShortsServer) replayFor(c *computedRun, lb liveBacktest) string {
	comparable := lb.recipe != nil && c.stored.row.Fundamentals == lb.recipe.Fundamentals
	runEnd, _ := civil.ParseDate(c.stored.row.WindowEnd)
	var paperEnd civil.Date
	if n := len(c.paper.equity); n > 0 {
		paperEnd, _ = civil.ParseDate(c.paper.equity[n-1].AsOf)
	}
	return replayAgreement(c.stored.trades, c.paper.trades, c.chain.liveFrom, c.chain.hasLive, runEnd, paperEnd, comparable)
}

// stateOnlyRun answers a strategy with no computed figures: its state and the copy that explains it.
func stateOnlyRun(id string, state, reason string, row *shortsstore.BacktestRunRow, runningSince time.Time) *shortsv1alpha1.BacktestRun {
	run := &shortsv1alpha1.BacktestRun{State: state, StateReason: reason, StrategyId: id}
	if !runningSince.IsZero() {
		run.RunningSince = runningSince.UTC().Format(time.RFC3339)
	}
	if row != nil {
		if state == backtestStateNotComputable {
			run.ComputableFrom = row.ComputableFrom
			run.FiscalLabel = row.FiscalLabel
			if share, ok := summaryShare(row.Summary); ok {
				run.ComputableSharePct = round2(share * 100)
				run.HasComputableShare = true
			}
		}
	}
	return run
}

// strategyIDOf is a canonical strategy id from a request field: required, lower case, and registered.
// An unknown id is NotFound.
func strategyIDOf(raw string) (string, error) {
	id := strings.ToLower(strings.TrimSpace(raw))
	if id == "" {
		return "", connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("strategy_id is required (one of %s)", strategyIDList()))
	}
	if _, ok := engine.Lookup(id); !ok {
		return "", connect.NewError(connect.CodeNotFound, fmt.Errorf("unknown strategy_id %q (one of %s)", raw, strategyIDList()))
	}
	return id, nil
}

// normaliseWindow and normaliseResolution validate the request's window and resolution, with their
// defaults (the since-May-2019 chain, weekly).
func normaliseWindow(raw string) (string, error) {
	switch w := strings.ToLower(strings.TrimSpace(raw)); w {
	case "", windowSince2019:
		return windowSince2019, nil
	case windowSince2023, windowTrailing12, windowLive:
		return w, nil
	default:
		return "", connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("window %q is not since_2019_05, since_2023, trailing_12m or live", raw))
	}
}

func normaliseResolution(raw string) (string, error) {
	switch r := strings.ToLower(strings.TrimSpace(raw)); r {
	case "", "weekly":
		return "weekly", nil
	case "daily":
		return "daily", nil
	default:
		return "", connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("resolution %q is not weekly or daily", raw))
	}
}

// GetBacktestRun returns a strategy's canonical backtest: the live version's published run (run_id 0), or
// a canonical run by id. A variant run, a gate-refused run and an unknown id are NotFound. A run that is
// not computed answers its state and reason. Cached per instance by (strategy, run, resolution, window).
func (s *ShortsServer) GetBacktestRun(ctx context.Context, req *connect.Request[shortsv1alpha1.GetBacktestRunRequest]) (*connect.Response[shortsv1alpha1.GetBacktestRunResponse], error) {
	id, err := strategyIDOf(req.Msg.StrategyId)
	if err != nil {
		return nil, err
	}
	resolution, err := normaliseResolution(req.Msg.Resolution)
	if err != nil {
		return nil, err
	}
	window, err := normaliseWindow(req.Msg.Window)
	if err != nil {
		return nil, err
	}
	key := fmt.Sprintf("backtest_run:%s:%d:%s:%s", id, req.Msg.RunId, resolution, window)
	v, err := s.cachedBacktest(key, func() (any, error) {
		return s.backtestRunResponse(context.WithoutCancel(ctx), id, req.Msg.RunId, resolution, window)
	})
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(proto.Clone(v.(*shortsv1alpha1.GetBacktestRunResponse)).(*shortsv1alpha1.GetBacktestRunResponse)), nil
}

// backtestRunResponse is the uncached answer of GetBacktestRun.
func (s *ShortsServer) backtestRunResponse(ctx context.Context, id string, runID int64, resolution, window string) (*shortsv1alpha1.GetBacktestRunResponse, error) {
	lb, err := s.liveBacktestOf(ctx, id)
	if err != nil {
		s.logger.Errorf("GetBacktestRun: reading the version table for %s failed: %v", id, err)
		return nil, connect.NewError(connect.CodeUnavailable, errors.New("backtest is not available"))
	}
	if runID != 0 {
		if s.strategyBacktests == nil {
			return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("no canonical backtest run %d", runID))
		}
		row, ok, err := s.strategyBacktests.ReadCanonicalBacktest(ctx, runID)
		if err != nil && !errors.Is(err, shortsstore.ErrStrategyBacktestSchema) {
			s.logger.Errorf("GetBacktestRun: reading run %d failed: %v", runID, err)
			return nil, connect.NewError(connect.CodeUnavailable, errors.New("backtest is not available"))
		}
		if !ok || row.StrategyID != id {
			return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("no canonical backtest run %d of %s", runID, id))
		}
		if summaryState(row.Summary) == backtestStateNotComputable {
			return &shortsv1alpha1.GetBacktestRunResponse{Run: stateOnlyRun(id, backtestStateNotComputable, notComputableReason(row), &row, time.Time{})}, nil
		}
		run, err := s.publishedRun(ctx, lb, row, resolution, window)
		if err != nil {
			s.logger.Errorf("GetBacktestRun: run %d failed: %v", runID, err)
			return nil, connect.NewError(connect.CodeUnavailable, errors.New("backtest is not available"))
		}
		return &shortsv1alpha1.GetBacktestRunResponse{Run: run}, nil
	}
	bs, err := s.backtestStateOf(ctx, lb)
	if err != nil {
		s.logger.Errorf("GetBacktestRun: reading the backtest state of %s failed: %v", id, err)
		return nil, connect.NewError(connect.CodeUnavailable, errors.New("backtest is not available"))
	}
	if bs.state == backtestStatePublished {
		run, err := s.publishedRun(ctx, lb, *bs.computed, resolution, window)
		if err != nil {
			s.logger.Errorf("GetBacktestRun: the live run of %s failed: %v", id, err)
			return nil, connect.NewError(connect.CodeUnavailable, errors.New("backtest is not available"))
		}
		return &shortsv1alpha1.GetBacktestRunResponse{Run: run}, nil
	}
	return &shortsv1alpha1.GetBacktestRunResponse{Run: stateOnlyRun(id, bs.state, bs.reason, bs.notComputed, bs.runningSince)}, nil
}

// summaryState is a run's stored state; "" when the summary does not carry one.
func summaryState(summary []byte) string {
	var s struct {
		State string `json:"state"`
	}
	if json.Unmarshal(summary, &s) != nil {
		return ""
	}
	return s.State
}

// publishedRun reads a publishable run's stored parts and its paper track, and builds its answer.
func (s *ShortsServer) publishedRun(ctx context.Context, lb liveBacktest, row shortsstore.BacktestRunRow, resolution, window string) (*shortsv1alpha1.BacktestRun, error) {
	sr, err := s.loadStoredRun(ctx, row)
	if err != nil {
		return nil, err
	}
	pt, err := s.readPaperTrack(ctx, row.RulesHash, row.RecipeHash, lb.sinceOf(row.RulesHash))
	if err != nil {
		return nil, err
	}
	return s.runFromStored(ctx, lb, sr, pt, window, resolution)
}

// ListStrategyEvidence is every strategy's backtest evidence: its state and reason, its chained windows,
// its annual returns, its month-end curve and the paper track. A read that fails fails the whole list; a
// state is never guessed for one strategy. Cached per instance.
func (s *ShortsServer) ListStrategyEvidence(ctx context.Context, _ *connect.Request[shortsv1alpha1.ListStrategyEvidenceRequest]) (*connect.Response[shortsv1alpha1.ListStrategyEvidenceResponse], error) {
	v, err := s.cachedBacktest("backtest_evidence", func() (any, error) {
		return s.evidenceResponse(context.WithoutCancel(ctx))
	})
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(proto.Clone(v.(*shortsv1alpha1.ListStrategyEvidenceResponse)).(*shortsv1alpha1.ListStrategyEvidenceResponse)), nil
}

// evidenceResponse is the uncached answer of ListStrategyEvidence.
func (s *ShortsServer) evidenceResponse(ctx context.Context) (*shortsv1alpha1.ListStrategyEvidenceResponse, error) {
	out := &shortsv1alpha1.ListStrategyEvidenceResponse{
		WindowStart:   backtestWindowStart,
		BenchmarkName: benchmarkName,
		Footnotes: []string{
			"Hypothetical results from rules applied to historical data, not a record of trading. Not financial advice.",
			"Total return against the S&P/ASX 200 Gross Total Return index (XJT), franking excluded.",
			"Since May 2019 is in-sample up to the day the rules froze, then the recorded paper track.",
		},
	}
	for _, st := range engine.Registry() {
		ev, prices, err := s.strategyEvidence(ctx, st)
		if err != nil {
			s.logger.Errorf("ListStrategyEvidence: %s failed: %v", st.ID, err)
			return nil, connect.NewError(connect.CodeUnavailable, errors.New("strategy evidence is not available"))
		}
		if prices > out.PricesThrough {
			out.PricesThrough = prices
		}
		out.Strategies = append(out.Strategies, ev)
	}
	return out, nil
}

// strategyEvidence assembles one strategy's evidence and the price session its run read.
func (s *ShortsServer) strategyEvidence(ctx context.Context, st engine.Strategy) (*shortsv1alpha1.StrategyEvidence, string, error) {
	lb, err := s.liveBacktestOf(ctx, st.ID)
	if err != nil {
		return nil, "", err
	}
	bs, err := s.backtestStateOf(ctx, lb)
	if err != nil {
		return nil, "", err
	}
	ev := &shortsv1alpha1.StrategyEvidence{StrategyId: st.ID, State: bs.state, StateReason: bs.reason}
	if lb.found {
		ev.Version = versionRefWith(lb.reg, lb.hash, lb.table.stateOf(lb.reg, lb.hash))
	}
	// One paper read per strategy: the summary and the chain both use it.
	pt, err := s.readPaperTrack(ctx, lb.hash, lb.recipeHash, lb.sinceOf(lb.hash))
	if err != nil {
		return nil, "", err
	}
	var prices string
	switch bs.state {
	case backtestStatePublished:
		sr, err := s.loadStoredRun(ctx, *bs.computed)
		if err != nil {
			return nil, "", err
		}
		c, err := s.assembleRun(ctx, sr, pt)
		if err != nil {
			return nil, "", err
		}
		for _, f := range c.figs {
			ev.Windows = append(ev.Windows, windowMetrics(f, c.spanOf(f), c.windowTrades()))
		}
		applyReferenceFallback(ev.Windows, c.chain.days, sr.summary)
		applyWindowNotes(ev.Windows, c)
		ev.Annual, _ = periodTables(c.chain.days, sr.summary.Coverage, sr.summary.Survivorship.Measurement)
		for _, k := range monthEnds(c.chain.days, evidenceMonthCap) {
			ev.MiniCurve = append(ev.MiniCurve, seriesOf(c.chain.days, []int{k})...)
		}
		ev.RunId = bs.computed.ID
		ev.Survivorship = survivorshipStatement(sr.summary.Survivorship)
		prices = bs.computed.PricesThrough
	case backtestStateNotComputable:
		ev.ComputableFrom = bs.notComputed.ComputableFrom
		ev.FiscalLabel = bs.notComputed.FiscalLabel
		if share, ok := summaryShare(bs.notComputed.Summary); ok {
			ev.ComputableSharePct = round2(share * 100)
			ev.HasComputableShare = true
		}
	case backtestStateRunning:
		ev.RunningSince = bs.runningSince.UTC().Format(time.RFC3339)
	}
	ev.Paper = paperSummaryOf(pt.since, pt.equity, pt.trades)

	if eval, err := s.loadStrategyEvaluation(ctx, st); err == nil {
		ev.Today = statusCounts(eval.picks)
		ev.LatestScreen = eval.universe.asOf
	} else {
		s.logger.Warnf("strategy evidence: today's counts of %s unavailable: %v", st.ID, err)
	}
	return ev, prices, nil
}

// survivorshipStatement is the statement the evidence carries: the copy, with the Minervini caveat where
// the run states one.
func survivorshipStatement(s backtest.Survivorship) string {
	if s.Caveat == "" {
		return s.Copy
	}
	return s.Copy + " " + s.Caveat
}

// ListBacktestTrades pages the trades of one canonical run: keyset paging on seq, with the stock and exit
// filters applied in SQL. A variant, gate-refused, not-computed or unknown run is NotFound.
func (s *ShortsServer) ListBacktestTrades(ctx context.Context, req *connect.Request[shortsv1alpha1.ListBacktestTradesRequest]) (*connect.Response[shortsv1alpha1.ListBacktestTradesResponse], error) {
	if _, _, err := privateAccess(ctx); err != nil {
		return nil, err
	}
	runID := req.Msg.RunId
	if runID <= 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("run_id is required"))
	}
	size := int(req.Msg.PageSize)
	switch {
	case size == 0:
		size = 50
	case size < 1 || size > 200:
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("page_size must be between 1 and 200"))
	}
	after := 0
	if tok := strings.TrimSpace(req.Msg.PageToken); tok != "" {
		n, err := strconv.Atoi(tok)
		if err != nil || n < 0 {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("page_token is not valid"))
		}
		after = n
	}
	if s.strategyBacktests == nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("no canonical backtest run"))
	}
	row, ok, err := s.strategyBacktests.ReadCanonicalBacktest(ctx, runID)
	if err != nil && !errors.Is(err, shortsstore.ErrStrategyBacktestSchema) {
		s.logger.Errorf("ListBacktestTrades: reading run %d failed: %v", runID, err)
		return nil, connect.NewError(connect.CodeUnavailable, errors.New("trades are not available"))
	}
	if !ok || summaryState(row.Summary) == backtestStateNotComputable {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("no canonical backtest run %d", runID))
	}
	filter := shortsstore.BacktestTradeFilter{
		StockCode:  strings.ToUpper(strings.TrimSpace(req.Msg.StockCode)),
		ExitReason: strings.TrimSpace(req.Msg.ExitReason),
	}
	total, err := s.strategyBacktests.CountBacktestTrades(ctx, runID, filter)
	if err != nil && !errors.Is(err, shortsstore.ErrStrategyBacktestSchema) {
		s.logger.Errorf("ListBacktestTrades: counting run %d failed: %v", runID, err)
		return nil, connect.NewError(connect.CodeUnavailable, errors.New("trades are not available"))
	}
	rows, err := s.strategyBacktests.ReadBacktestTradesPage(ctx, runID, filter, after, size+1)
	if err != nil && !errors.Is(err, shortsstore.ErrStrategyBacktestSchema) {
		s.logger.Errorf("ListBacktestTrades: a page of run %d failed: %v", runID, err)
		return nil, connect.NewError(connect.CodeUnavailable, errors.New("trades are not available"))
	}
	out := &shortsv1alpha1.ListBacktestTradesResponse{Total: int32(total), Trades: []*shortsv1alpha1.BacktestTrade{}}
	if len(rows) > size {
		rows = rows[:size]
		out.NextPageToken = strconv.Itoa(rows[len(rows)-1].Seq)
	}
	for _, t := range rows {
		out.Trades = append(out.Trades, backtestTradeOf(t))
	}
	return connect.NewResponse(out), nil
}

// backtestTradeOf maps one stored trade onto the wire.
func backtestTradeOf(t shortsstore.BacktestTradeRow) *shortsv1alpha1.BacktestTrade {
	out := &shortsv1alpha1.BacktestTrade{
		Seq:            int32(t.Seq),
		StockCode:      t.StockCode,
		CompanyName:    t.CompanyName,
		SignalDate:     t.SignalDate,
		EntryDate:      t.EntryDate,
		EntryPrice:     round4(t.EntryPrice),
		EntryScore:     roundTenth(t.EntryScore),
		ExitSignalDate: t.ExitSignalDate,
		ExitDate:       t.ExitDate,
		ExitPrice:      round4(t.ExitPrice),
		ExitReason:     t.ExitReason,
		SessionsHeld:   int32(t.SessionsHeld),
		GrossReturnPct: round2(t.GrossReturnPct),
		NetReturnPct:   round2(t.NetReturnPct),
		Flags:          t.Flags,
		Open:           t.Open,
	}
	if t.CapturedPivot != nil {
		out.CapturedPivot, out.HasCapturedPivot = round4(*t.CapturedPivot), true
	}
	return out
}

// roundTenth rounds to one decimal, half away from zero. It hides the float32 noise an entry score carries.
func roundTenth(v float64) float64 {
	if v < 0 {
		return -math.Round(-v*10) / 10
	}
	return math.Round(v*10) / 10
}

// CompareStrategies puts two or three canonical strategies side by side over the sessions every one of
// them covers. A strategy with no published run is returned in its state, with no curve, and no
// correlations are computed for it. The rule diff names each recipe line that differs between a pair.
func (s *ShortsServer) CompareStrategies(ctx context.Context, req *connect.Request[shortsv1alpha1.CompareStrategiesRequest]) (*connect.Response[shortsv1alpha1.CompareStrategiesResponse], error) {
	if _, _, err := privateAccess(ctx); err != nil {
		return nil, err
	}
	if n := len(req.Msg.Refs); n < 2 || n > 3 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("compare two or three strategies"))
	}
	ids := make([]string, 0, len(req.Msg.Refs))
	seen := map[string]bool{}
	for _, raw := range req.Msg.Refs {
		ref := strings.TrimSpace(raw)
		if strings.HasPrefix(strings.ToLower(ref), "variant:") {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("variant comparison is not available yet: compare canonical strategies"))
		}
		id, err := strategyIDOf(ref)
		if err != nil {
			return nil, err
		}
		if seen[id] {
			return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("strategy %s is named twice", id))
		}
		seen[id] = true
		ids = append(ids, id)
	}
	if s.strategyBacktests == nil {
		return nil, connect.NewError(connect.CodeUnavailable, errors.New("backtests are not available"))
	}

	type part struct {
		entry *shortsv1alpha1.CompareEntry
		c     *computedRun
		lb    liveBacktest
	}
	parts := make([]part, 0, len(ids))
	for _, id := range ids {
		st, _ := engine.Lookup(id)
		lb, err := s.liveBacktestOf(ctx, id)
		if err != nil {
			return nil, connect.NewError(connect.CodeUnavailable, errors.New("backtests are not available"))
		}
		bs, err := s.backtestStateOf(ctx, lb)
		if err != nil {
			return nil, connect.NewError(connect.CodeUnavailable, errors.New("backtests are not available"))
		}
		p := part{lb: lb, entry: &shortsv1alpha1.CompareEntry{
			StrategyRef: id, StrategyId: id, Name: st.Name, State: bs.state, StateReason: bs.reason,
			Version: versionRefWith(lb.reg, lb.hash, lb.table.stateOf(lb.reg, lb.hash)),
		}}
		if bs.state == backtestStatePublished {
			sr, err := s.loadStoredRun(ctx, *bs.computed)
			if err != nil {
				s.logger.Errorf("CompareStrategies: run of %s failed: %v", id, err)
				return nil, connect.NewError(connect.CodeUnavailable, errors.New("backtests are not available"))
			}
			pt, err := s.readPaperTrack(ctx, lb.hash, lb.recipeHash, lb.sinceOf(lb.hash))
			if err != nil {
				return nil, connect.NewError(connect.CodeUnavailable, errors.New("backtests are not available"))
			}
			c, err := s.assembleRun(ctx, sr, pt)
			if err != nil {
				s.logger.Errorf("CompareStrategies: assembling %s failed: %v", id, err)
				return nil, connect.NewError(connect.CodeUnavailable, errors.New("backtests are not available"))
			}
			p.c = c
		}
		parts = append(parts, p)
	}

	out := &shortsv1alpha1.CompareStrategiesResponse{}
	for _, p := range parts {
		if p.c == nil {
			// A strategy with no curve is returned in its state; there is no common window to compare.
			for _, q := range parts {
				out.Entries = append(out.Entries, q.entry)
			}
			return connect.NewResponse(out), nil
		}
	}

	// The common window: the sessions every compared curve covers.
	first := parts[0].c.chain.days
	from, to := first[0].date, first[len(first)-1].date
	for _, p := range parts[1:] {
		days := p.c.chain.days
		if d := days[0].date; d.After(from) {
			from = d
		}
		if d := days[len(days)-1].date; d.Before(to) {
			to = d
		}
	}
	if from.After(to) {
		return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("the compared strategies share no session"))
	}
	out.WindowId, out.WindowFrom, out.WindowTo = "common", from.String(), to.String()

	returns := map[string]map[civil.Date]float64{}
	for _, p := range parts {
		sub := daysBetween(p.c.chain.days, from, to)
		if len(sub) == 0 {
			return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("the compared strategies share no session"))
		}
		series := backtest.Series{Basis: backtest.BasisTotal, Curve: curveOf(sub)}
		f := backtest.WindowOf("common", "Common window", series, nil, "")
		trades := windowTradesFor(p.c.stored.trades, p.c.paper.trades, p.c.chain.liveFrom, p.c.chain.hasLive, p.c.chain.paper != nil)
		p.entry.Window = windowMetrics(f, sub, trades)
		p.entry.Series = seriesOf(sub, keptSessions(sub, nil))
		returns[p.entry.StrategyId] = dailyReturns(sub)
		out.Entries = append(out.Entries, p.entry)
	}
	for i := 0; i < len(ids); i++ {
		for j := i + 1; j < len(ids); j++ {
			corr, days, ok := correlate(returns[ids[i]], returns[ids[j]])
			out.Correlations = append(out.Correlations, &shortsv1alpha1.StrategyCorrelation{
				A: ids[i], B: ids[j], Correlation: round2(corr), HasCorrelation: ok, Days: int32(days),
			})
			out.RuleDiffs = append(out.RuleDiffs, ruleDiffs(ids[i], ids[j], parts[i].lb, parts[j].lb)...)
		}
	}
	return connect.NewResponse(out), nil
}

// windowTradesFor is the trades a window counts: the in-sample trades that exited before the cut and the
// paper trades that closed, each with its net return where it has one.
func windowTradesFor(run []shortsstore.BacktestTradeRow, paper []shortsstore.PaperTradeRow, liveFrom civil.Date, hasLive, hasPaper bool) []windowTrade {
	var out []windowTrade
	for _, t := range run {
		if t.Open || t.ExitDate == "" {
			continue
		}
		exit, err := civil.ParseDate(t.ExitDate)
		if err != nil || (hasLive && !exit.Before(liveFrom)) {
			continue
		}
		out = append(out, windowTrade{exit: exit, net: t.NetReturnPct / 100, hasNet: true})
	}
	if !hasPaper {
		return out
	}
	for _, t := range paper {
		if t.Status != "closed" || t.ExitDate == "" {
			continue
		}
		if exit, err := civil.ParseDate(t.ExitDate); err == nil {
			out = append(out, windowTrade{exit: exit, net: t.NetReturnPct / 100, hasNet: t.HasNet})
		}
	}
	return out
}

// ruleDiffs names each recipe line that differs between two live recipes. A strategy with no recipe
// contributes no lines, so nothing is compared against it.
func ruleDiffs(a, b string, la, lb liveBacktest) []*shortsv1alpha1.RuleDiff {
	if la.recipe == nil || lb.recipe == nil {
		return nil
	}
	fa, fb := recipeFields(*la.recipe), recipeFields(*lb.recipe)
	var out []*shortsv1alpha1.RuleDiff
	for _, name := range sortedPairKeys(fa) {
		if fa[name] != fb[name] {
			out = append(out, &shortsv1alpha1.RuleDiff{A: a, B: b, Field: name, AValue: fa[name], BValue: fb[name]})
		}
	}
	return out
}

// recipeFields is a recipe's prose by line, without the preface (which every recipe shares).
func recipeFields(r spec.Recipe) map[string]string {
	lines, err := spec.RenderRecipeLines(r)
	if err != nil {
		return map[string]string{}
	}
	return map[string]string{
		"entry":     lines.Entry,
		"exits":     strings.Join(lines.Exits, " "),
		"sizing":    lines.Sizing,
		"brokerage": lines.Brokerage,
		"spread":    lines.Spread,
		"capacity":  lines.Capacity,
		"dividends": lines.Dividends,
		"asic_data": lines.ASICData,
		"delisting": lines.Delisting,
		"capital":   lines.Capital,
		"cash":      lines.Cash,
	}
}
