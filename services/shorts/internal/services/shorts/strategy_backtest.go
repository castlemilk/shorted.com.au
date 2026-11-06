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

	"cloud.google.com/go/civil"
	"connectrpc.com/connect"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/backtest"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/features"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// The backtest rpcs (PR-18). The public reads (GetBacktestRun, ListStrategyEvidence) serve
// canonical runs only and are caller-invariant: no caller's claims reach them. The private
// reads (ListBacktestTrades, CompareStrategies) need a signed-in caller and resolve their
// run ids under no owner, because canonical runs are shared; a variant reference is refused
// until variant backtests ship.

// benchmarkName is the benchmark every run is measured against (5.7).
const benchmarkName = "S&P/ASX 200 Gross Total Return (XJT)"

// backtestWindowStart is the first canonical session: 2019-05-01, the first full month of XJT.
const backtestWindowStart = "2019-05-01"

// backtestStates are the states a strategy's live backtest can be in (1.7).
const (
	backtestStateComputed      = "computed"
	backtestStateRunRequired   = "run_required"
	backtestStateRunning       = "running"
	backtestStateNotComputable = "not_computable"
)

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

// liveBacktestOf resolves a strategy's live version: the version table's live row, or the
// registry's live flag when the table has none.
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

// backtestState is where a strategy's live backtest stands, with the run it reads from.
type backtestState struct {
	state        string
	computed     *shortsstore.BacktestRunRow
	runningSince time.Time
	notComputed  *shortsstore.BacktestRunRow
}

// backtestStateOf reads the state of a strategy's live backtest. A strategy with no
// recipe is not computable; a missing table reads as no run yet, so every strategy answers
// in a well-defined state, never an error.
func (s *ShortsServer) backtestStateOf(ctx context.Context, lb liveBacktest) (backtestState, error) {
	if !lb.found || lb.recipe == nil {
		return backtestState{state: backtestStateNotComputable}, nil
	}
	st := s.strategyBacktests
	if st == nil {
		return backtestState{state: backtestStateRunRequired}, nil
	}
	row, ok, err := st.ReadPublishedBacktest(ctx, lb.strategyID, lb.hash, lb.recipeHash)
	if err != nil && !errors.Is(err, shortsstore.ErrStrategyBacktestSchema) {
		return backtestState{}, err
	}
	if ok {
		return backtestState{state: backtestStateComputed, computed: &row}, nil
	}
	since, running, err := st.ReadRunningBacktest(ctx, lb.strategyID, lb.hash, lb.recipeHash)
	if err != nil && !errors.Is(err, shortsstore.ErrStrategyBacktestSchema) {
		return backtestState{}, err
	}
	if running {
		return backtestState{state: backtestStateRunning, runningSince: since}, nil
	}
	nc, ok, err := st.ReadNotComputableBacktest(ctx, lb.strategyID, lb.hash, lb.recipeHash)
	if err != nil && !errors.Is(err, shortsstore.ErrStrategyBacktestSchema) {
		return backtestState{}, err
	}
	if ok {
		return backtestState{state: backtestStateNotComputable, notComputed: &nc}, nil
	}
	return backtestState{state: backtestStateRunRequired}, nil
}

// storedSummary is a run's summary document. The job marshals the backtest package's own
// types, which carry no JSON tags, so each field decodes by its Go name; DiffNote is the
// exception, tagged in the package. Share is a pointer so an absent key reads as absent.
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

// computedRun is a published run with its series, trades and paper track read and chained.
type computedRun struct {
	row         shortsstore.BacktestRunRow
	summary     storedSummary
	chain       chainedRun
	trades      []shortsstore.BacktestTradeRow
	paperTrades []shortsstore.PaperTradeRow
	cash        []features.RatePoint
}

// loadComputedRun reads a run's series, trades and paper track and chains them. A missing
// series is an error: a computed run without one cannot be served.
func (s *ShortsServer) loadComputedRun(ctx context.Context, row shortsstore.BacktestRunRow) (computedRun, error) {
	st := s.strategyBacktests
	raw, err := st.ReadBacktestSeries(ctx, row.ID)
	if err != nil {
		return computedRun{}, err
	}
	if raw == nil {
		return computedRun{}, fmt.Errorf("backtest run %d has no series", row.ID)
	}
	var series storedSeries
	if err := json.Unmarshal(raw, &series); err != nil {
		return computedRun{}, fmt.Errorf("backtest run %d: decode the series: %w", row.ID, err)
	}
	var sum storedSummary
	if err := json.Unmarshal(row.Summary, &sum); err != nil {
		return computedRun{}, fmt.Errorf("backtest run %d: decode the summary: %w", row.ID, err)
	}
	paperRows, err := st.ReadPaperEquity(ctx, row.RulesHash, row.RecipeHash)
	if err != nil && !errors.Is(err, shortsstore.ErrStrategyBacktestSchema) {
		return computedRun{}, err
	}
	chain, err := buildChainedRun(series, row.InSampleUntil, paperRows)
	if err != nil {
		return computedRun{}, fmt.Errorf("backtest run %d: %w", row.ID, err)
	}
	trades, err := st.ReadBacktestTrades(ctx, row.ID)
	if err != nil && !errors.Is(err, shortsstore.ErrStrategyBacktestSchema) {
		return computedRun{}, err
	}
	paperTrades, err := st.ReadPaperTrades(ctx, row.RulesHash, row.RecipeHash)
	if err != nil && !errors.Is(err, shortsstore.ErrStrategyBacktestSchema) {
		return computedRun{}, err
	}
	// The cash series is the Sharpe ratio's risk-free rate. A failed read leaves the ratio
	// without one ("risk-free: none"), which the identity states, rather than failing the run.
	latest := chain.days[len(chain.days)-1].date
	cash, err := st.ReadCashRate(ctx, latest)
	if err != nil {
		s.logger.Warnf("backtest run %d: the cash rate is unavailable, the Sharpe ratio has no risk-free rate: %v", row.ID, err)
		cash = nil
	}
	return computedRun{row: row, summary: sum, chain: chain, trades: trades, paperTrades: paperTrades, cash: cash}, nil
}

// windows are the chained windows of the run (5.8), from the backtest package's own
// chaining.
func (c computedRun) windows() ([]backtest.WindowFigures, error) {
	return backtest.Windows(c.chain.bt, c.chain.paper, c.chain.liveFrom, c.cash)
}

// windowMetrics maps the figures of one window, with the trade and exposure figures the
// package does not measure (5.9).
func (c computedRun) windowMetrics(f backtest.WindowFigures) *shortsv1alpha1.WindowMetrics {
	days := daysBetween(c.chain.days, f.Start, f.End)
	trades := windowTrades(c.trades, c.paperTrades, c.chain.liveFrom, c.chain.hasLive, c.chain.paper != nil)
	return windowMetricsOf(f, days, trades)
}

// windowMetricsOf maps one window's figures onto the wire. Benchmark and reference CAGR
// are shown only when every session of the window carries the series. Win rate is withheld
// for a window that holds paper sessions (see closedAndWinRate).
func windowMetricsOf(f backtest.WindowFigures, days []chainDay, trades []windowTrade) *shortsv1alpha1.WindowMetrics {
	m := &shortsv1alpha1.WindowMetrics{
		Window:         f.ID,
		From:           f.Start.String(),
		To:             f.End.String(),
		TotalReturnPct: round6(f.TotalReturn * 100),
		CagrPct:        round6(f.CAGR * 100),
		HasCagr:        f.HasCAGR,
		MaxDrawdownPct: round6(f.MaxDrawdown.Depth * 100),
		Sharpe:         round6(f.Sharpe.Annual),
		SharpeSe:       round6(f.Sharpe.SE),
		HasSharpe:      f.Sharpe.Shown,
		Label:          f.Label,
		Note:           f.Note,
		NotAnnualised:  f.NotAnnualised,
		Sessions:       int32(f.Sessions),
		CalendarDays:   int32(f.CalendarDays),
		VolatilityPct:  round6(f.Volatility * 100),
		HasVolatility:  f.HasVolatility,
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
		m.ExposurePct = round6(exposure / float64(len(days)) * 100)
	}
	m.RecordedTail = recorded
	if allBench {
		if cagr, ok := backtest.CAGR(curveOfField(days, func(d chainDay) float64 { return d.bench })); ok {
			m.BenchmarkCagrPct, m.HasBenchmark = round6(cagr*100), true
		}
	}
	if allRef {
		if cagr, ok := backtest.CAGR(curveOfField(days, func(d chainDay) float64 { return d.ref })); ok {
			m.ReferenceCagrPct, m.HasReference = round6(cagr*100), true
		}
	}
	closed, win, hasWin := closedAndWinRate(trades, f.Start, f.End, recorded)
	m.ClosedTrades = int32(closed)
	m.WinRatePct, m.HasWinRate = round6(win), hasWin
	return m
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

// coverageRows are both measures by year and by month, one row per period. A period a
// measure does not carry reads as absent, not zero.
// coveragePair is one period under both measures.
type coveragePair struct{ q, a *backtest.CoveragePeriod }

func coverageRows(cov backtest.Coverage) ([]*shortsv1alpha1.CoverageYear, []*shortsv1alpha1.CoverageMonth) {
	years := map[string]*coveragePair{}
	months := map[string]*coveragePair{}
	add := func(m map[string]*coveragePair, p backtest.CoveragePeriod, qual bool) {
		e := m[p.Period]
		if e == nil {
			e = &coveragePair{}
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
	var outY []*shortsv1alpha1.CoverageYear
	for _, k := range sortedKeys(years) {
		e := years[k]
		row := &shortsv1alpha1.CoverageYear{}
		if y, err := strconv.Atoi(k); err == nil {
			row.Year = int32(y)
		}
		row.QualifyingPct, row.HasQualifying, row.QualifyingPriced, row.QualifyingNameDays = coveragePeriodFields(e.q)
		row.AllReportedPct, row.HasAllReported, row.AllReportedPriced, row.AllReportedNameDays = coveragePeriodFields(e.a)
		outY = append(outY, row)
	}
	var outM []*shortsv1alpha1.CoverageMonth
	for _, k := range sortedKeys(months) {
		e := months[k]
		row := &shortsv1alpha1.CoverageMonth{Month: k}
		row.QualifyingPct, row.HasQualifying, row.QualifyingPriced, row.QualifyingNameDays = coveragePeriodFields(e.q)
		row.AllReportedPct, row.HasAllReported, row.AllReportedPriced, row.AllReportedNameDays = coveragePeriodFields(e.a)
		outM = append(outM, row)
	}
	return outY, outM
}

// coveragePeriodFields are one measure's figures for a period; the ratio is shown only
// when the measure has name-days in the period.
func coveragePeriodFields(p *backtest.CoveragePeriod) (pct float64, has bool, priced, names int32) {
	if p == nil {
		return 0, false, 0, 0
	}
	priced, names = int32(p.Priced), int32(p.Qualifying)
	if p.Qualifying > 0 {
		return round6(p.Ratio * 100), true, priced, names
	}
	return 0, false, priced, names
}

// sortedKeys is the keys of a period map in order.
func sortedKeys(m map[string]*coveragePair) []string {
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
			Applies:              r.Applies,
			Reason:               r.Reason,
			CagrPct:              round6(r.Figures.CAGR * 100),
			HasCagr:              r.Figures.HasCAGR,
			ExcessVsBenchmarkPct: round6(r.Figures.Excess * 100),
			HasExcess:            r.Figures.HasExcess,
			MaxDrawdownPct:       round6(r.Figures.MaxDrawdown * 100),
			Fragile:              r.Fragile != "",
			FragileChip:          backtest.FragileChip(r.Fragile),
		})
	}
	return out
}

// diffNoteOf is the diff note's copy: the codes whose price rows changed since the previous
// run, and the CAGR shift they caused. "" when there is no previous run to compare with.
func diffNoteOf(d backtest.DiffNote) string {
	var parts []string
	if d.RewrittenCount > 0 {
		parts = append(parts, fmt.Sprintf("%d codes' price rows rewritten since the previous run", d.RewrittenCount))
	}
	if d.RevisedCount > 0 {
		parts = append(parts, fmt.Sprintf("%d ASIC reports revised", d.RevisedCount))
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

// recipeLinesOf renders the recipe's prose, preface first. A recipe that does not render
// has no lines rather than a guess.
func recipeLinesOf(hash string) *shortsv1alpha1.RecipeLines {
	r, ok := recipeByHash(hash)
	if !ok {
		return nil
	}
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

// disclosuresOf is the copy every run prints beside its figures (1.8).
func disclosuresOf(inSampleUntil string, survivorship string) []string {
	out := []string{
		"Hypothetical results: rules applied to historical data, not record trading. Not financial advice.",
		"Total return: dividends adjusted by the price vendor, or credited in cash on the ex-date from ASX dividend notices where the vendor did not adjust them (notices from 11 Sep 2024); franking excluded. Benchmark: S&P/ASX 200 Gross Total Return (XJT).",
		"ASIC basis: the latest complete ASIC report published each session (T+4 sessions on a calendar derived from the data); values later revised; original publications not kept.",
		"Reference: the same price history and gaps, equal weight across the recipe's reference universe. Subtracting it does not remove survivorship bias.",
	}
	if inSampleUntil != "" {
		out = append(out, fmt.Sprintf("In-sample to %s, rules frozen; recorded after.", inSampleUntil))
	}
	if survivorship != "" {
		out = append(out, survivorship)
	}
	return out
}

// dataNotesOf names the counts a run excluded or could not price (5.11).
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

// runIdentityOf is a computed run's identity.
func runIdentityOf(c computedRun, lb liveBacktest) *shortsv1alpha1.BacktestRunIdentity {
	row := c.row
	risk := "none"
	if len(c.cash) > 0 && len(c.chain.days) > 0 && !c.cash[0].Date.After(c.chain.days[0].date) {
		risk = "RBA cash rate"
	}
	ref := c.summary.Reference.Label
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
		RunDate:           finished.Format("2006-01-02"),
	}
}

// recipeIDOf is the registered recipe's id for a hash, "" when none matches.
func recipeIDOf(hash string) string {
	if r, ok := recipeByHash(hash); ok {
		return r.ID
	}
	return ""
}

// computedBacktest assembles a computed run's full answer.
func (s *ShortsServer) computedBacktest(ctx context.Context, lb liveBacktest, row shortsstore.BacktestRunRow) (*shortsv1alpha1.BacktestRun, computedRun, error) {
	c, err := s.loadComputedRun(ctx, row)
	if err != nil {
		return nil, computedRun{}, err
	}
	figs, err := c.windows()
	if err != nil {
		return nil, computedRun{}, err
	}
	wins := make([]*shortsv1alpha1.WindowMetrics, 0, len(figs))
	for _, f := range figs {
		wins = append(wins, c.windowMetrics(f))
	}
	annual, monthly := periodTables(c.chain.days, c.summary.Coverage)
	covYears, covMonths := coverageRows(c.summary.Coverage)
	idx := keptSessions(c.chain.days, troughOf(c.chain.days))
	surv := c.summary.Survivorship
	run := &shortsv1alpha1.BacktestRun{
		State:           backtestStateComputed,
		StrategyId:      row.StrategyID,
		Identity:        runIdentityOf(c, lb),
		Windows:         wins,
		Annual:          annual,
		Monthly:         monthly,
		Series:          seriesOf(c.chain.days, idx),
		CoverageByYear:  covYears,
		CoverageMonthly: covMonths,
		Survivorship: &shortsv1alpha1.Survivorship{
			Measurement: surv.Measurement, Direction: surv.Direction, Statement: surv.Copy, Caveat: surv.Caveat,
		},
		Sensitivity:       sensitivitiesOf(c.summary.Sensitivity),
		Recipe:            recipeLinesOf(row.RecipeHash),
		TradeSummary:      tradeSummaryOf(c.trades),
		LiveVersion:       versionRefWith(lb.reg, lb.hash, lb.table.stateOf(lb.reg, lb.hash)),
		RulesMatchLive:    lb.found && row.RulesHash == lb.hash && row.RecipeHash == lb.recipeHash,
		EngineMatchesLive: row.EngineVersion == engine.Version,
		ReplayAgreement:   replayAgreementOf(c, lb),
		InputChangeNote:   diffNoteOf(c.summary.Diff),
		Disclosures:       disclosuresOf(row.InSampleUntil, surv.Copy),
		DataNotes:         dataNotesOf(c.summary.DataQuality),
		SeriesResolution:  "weekly",
	}
	return run, c, nil
}

// replayAgreementOf is the replay line of a run (5.13). A run whose fundamentals policy is
// not the live recipe's is not compared.
func replayAgreementOf(c computedRun, lb liveBacktest) string {
	comparable := lb.recipe != nil && c.row.Fundamentals == lb.recipe.Fundamentals
	return replayAgreement(c.trades, c.paperTrades, c.chain.liveFrom, c.chain.hasLive, comparable)
}

// troughOf is the index of the chained curve's deepest fall, -1 when it never falls.
func troughOf(days []chainDay) int {
	_, t := drawdowns(days)
	return t
}

// stateOnlyBacktest answers a run that has no computed figures: its state, and the copy
// that explains it.
func stateOnlyBacktest(id string, bs backtestState) *shortsv1alpha1.BacktestRun {
	run := &shortsv1alpha1.BacktestRun{State: bs.state, StrategyId: id}
	switch {
	case bs.state == backtestStateRunning && !bs.runningSince.IsZero():
		run.RunningSince = bs.runningSince.UTC().Format(time.RFC3339)
	case bs.state == backtestStateNotComputable && bs.notComputed != nil:
		run.ComputableFrom = bs.notComputed.ComputableFrom
		run.FiscalLabel = bs.notComputed.FiscalLabel
		if bs.notComputed.Summary != nil {
			var sum storedSummary
			if json.Unmarshal(bs.notComputed.Summary, &sum) == nil && sum.Share != nil {
				run.ComputableSharePct = round6(*sum.Share * 100)
				run.HasComputableShare = true
			}
		}
	}
	return run
}

// strategyIDOf is a canonical strategy id from a request field: required, lower case,
// and registered. An unknown id is NotFound.
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

// GetBacktestRun returns a strategy's published canonical backtest, or its state when none
// is computed. run_id 0 is the live version's published run; a variant or unknown run is
// NotFound.
func (s *ShortsServer) GetBacktestRun(ctx context.Context, req *connect.Request[shortsv1alpha1.GetBacktestRunRequest]) (*connect.Response[shortsv1alpha1.GetBacktestRunResponse], error) {
	id, err := strategyIDOf(req.Msg.StrategyId)
	if err != nil {
		return nil, err
	}
	switch strings.ToLower(strings.TrimSpace(req.Msg.Resolution)) {
	case "", "weekly":
	case "daily":
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("daily resolution is not served: the series is one point per ISO week, within the 500-point budget"))
	default:
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("resolution %q is not weekly or daily", req.Msg.Resolution))
	}
	lb, err := s.liveBacktestOf(ctx, id)
	if err != nil {
		s.logger.Errorf("GetBacktestRun: reading the version table for %s failed: %v", id, err)
		return nil, connect.NewError(connect.CodeUnavailable, errors.New("backtest is not available"))
	}
	if req.Msg.RunId != 0 {
		if s.strategyBacktests == nil {
			return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("no canonical backtest run %d", req.Msg.RunId))
		}
		row, ok, err := s.strategyBacktests.ReadCanonicalBacktest(ctx, req.Msg.RunId)
		if err != nil && !errors.Is(err, shortsstore.ErrStrategyBacktestSchema) {
			s.logger.Errorf("GetBacktestRun: reading run %d failed: %v", req.Msg.RunId, err)
			return nil, connect.NewError(connect.CodeUnavailable, errors.New("backtest is not available"))
		}
		if !ok || row.StrategyID != id {
			return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("no canonical backtest run %d of %s", req.Msg.RunId, id))
		}
		run, _, err := s.computedBacktest(ctx, lb, row)
		if err != nil {
			s.logger.Errorf("GetBacktestRun: run %d failed: %v", req.Msg.RunId, err)
			return nil, connect.NewError(connect.CodeUnavailable, errors.New("backtest is not available"))
		}
		return connect.NewResponse(&shortsv1alpha1.GetBacktestRunResponse{Run: run}), nil
	}
	bs, err := s.backtestStateOf(ctx, lb)
	if err != nil {
		s.logger.Errorf("GetBacktestRun: reading the backtest state of %s failed: %v", id, err)
		return nil, connect.NewError(connect.CodeUnavailable, errors.New("backtest is not available"))
	}
	if bs.state == backtestStateComputed {
		run, _, err := s.computedBacktest(ctx, lb, *bs.computed)
		if err != nil {
			s.logger.Errorf("GetBacktestRun: the live run of %s failed: %v", id, err)
			return nil, connect.NewError(connect.CodeUnavailable, errors.New("backtest is not available"))
		}
		return connect.NewResponse(&shortsv1alpha1.GetBacktestRunResponse{Run: run}), nil
	}
	return connect.NewResponse(&shortsv1alpha1.GetBacktestRunResponse{Run: stateOnlyBacktest(id, bs)}), nil
}

// ListStrategyEvidence is every strategy's backtest evidence: its state, its chained windows,
// its annual returns, its month-end curve and the paper track. A read that fails is an
// error for the whole list, never a state guessed for one strategy.
func (s *ShortsServer) ListStrategyEvidence(ctx context.Context, _ *connect.Request[shortsv1alpha1.ListStrategyEvidenceRequest]) (*connect.Response[shortsv1alpha1.ListStrategyEvidenceResponse], error) {
	out := &shortsv1alpha1.ListStrategyEvidenceResponse{
		WindowStart:   backtestWindowStart,
		BenchmarkName: benchmarkName,
		Footnotes: []string{
			"Hypothetical results: rules applied to historical data, not record trading. Not financial advice.",
			"Total return against the S&P/ASX 200 Gross Total Return index (XJT), franking excluded.",
			"Since May 2019 is in-sample up to the day the rules froze, then the recorded paper track.",
		},
	}
	for _, st := range engine.Registry() {
		ev, err := s.strategyEvidence(ctx, st)
		if err != nil {
			s.logger.Errorf("ListStrategyEvidence: %s failed: %v", st.ID, err)
			return nil, connect.NewError(connect.CodeUnavailable, errors.New("strategy evidence is not available"))
		}
		if ev.PricesThrough > out.PricesThrough {
			out.PricesThrough = ev.PricesThrough
		}
		out.Strategies = append(out.Strategies, ev.Evidence)
	}
	return connect.NewResponse(out), nil
}

// strategyEvidenceOf is one strategy's evidence and the prices its run read.
type strategyEvidenceOf struct {
	Evidence      *shortsv1alpha1.StrategyEvidence
	PricesThrough string
}

// strategyEvidence assembles one strategy's evidence.
func (s *ShortsServer) strategyEvidence(ctx context.Context, st engine.Strategy) (strategyEvidenceOf, error) {
	lb, err := s.liveBacktestOf(ctx, st.ID)
	if err != nil {
		return strategyEvidenceOf{}, err
	}
	bs, err := s.backtestStateOf(ctx, lb)
	if err != nil {
		return strategyEvidenceOf{}, err
	}
	ev := &shortsv1alpha1.StrategyEvidence{
		StrategyId: st.ID,
		Version:    versionRefWith(lb.reg, lb.hash, lb.table.stateOf(lb.reg, lb.hash)),
		State:      bs.state,
	}
	if !lb.found {
		ev.Version = nil
	}
	var pricesThrough string
	if bs.state == backtestStateComputed {
		c, err := s.loadComputedRun(ctx, *bs.computed)
		if err != nil {
			return strategyEvidenceOf{}, err
		}
		figs, err := c.windows()
		if err != nil {
			return strategyEvidenceOf{}, err
		}
		for _, f := range figs {
			ev.Windows = append(ev.Windows, c.windowMetrics(f))
		}
		ev.Annual, _ = periodTables(c.chain.days, c.summary.Coverage)
		for _, k := range monthEnds(c.chain.days, evidenceMonthCap) {
			ev.MiniCurve = append(ev.MiniCurve, seriesOf(c.chain.days, []int{k})...)
		}
		ev.RunId = bs.computed.ID
		ev.Survivorship = c.summary.Survivorship.Copy
		pricesThrough = bs.computed.PricesThrough
	}
	if bs.state == backtestStateNotComputable && bs.notComputed != nil {
		ev.ComputableFrom = bs.notComputed.ComputableFrom
		ev.FiscalLabel = bs.notComputed.FiscalLabel
	}

	paper, err := s.paperSummaryFor(ctx, lb)
	if err != nil {
		return strategyEvidenceOf{}, err
	}
	ev.Paper = paper

	if eval, err := s.loadStrategyEvaluation(ctx, st); err == nil {
		ev.Today = statusCounts(eval.picks)
		ev.LatestScreen = eval.universe.asOf
	} else {
		s.logger.Warnf("strategy evidence: today's counts of %s unavailable: %v", st.ID, err)
	}
	return strategyEvidenceOf{Evidence: ev, PricesThrough: pricesThrough}, nil
}

// paperSummaryFor is the live version's paper track since its live_from. A missing paper
// schema is an empty track.
func (s *ShortsServer) paperSummaryFor(ctx context.Context, lb liveBacktest) (*shortsv1alpha1.PaperTrackSummary, error) {
	since := ""
	if row, ok := lb.table.rows[lb.hash]; ok {
		since = row.LiveFrom
	}
	if s.strategyBacktests == nil || lb.recipeHash == "" {
		return paperSummaryOf(since, nil, nil), nil
	}
	rows, err := s.strategyBacktests.ReadPaperEquity(ctx, lb.hash, lb.recipeHash)
	if err != nil && !errors.Is(err, shortsstore.ErrStrategyBacktestSchema) {
		return nil, err
	}
	trades, err := s.strategyBacktests.ReadPaperTrades(ctx, lb.hash, lb.recipeHash)
	if err != nil && !errors.Is(err, shortsstore.ErrStrategyBacktestSchema) {
		return nil, err
	}
	return paperSummaryOf(since, rows, trades), nil
}

// ListBacktestTrades pages the trades of one canonical run. A variant or unknown run is
// NotFound.
func (s *ShortsServer) ListBacktestTrades(ctx context.Context, req *connect.Request[shortsv1alpha1.ListBacktestTradesRequest]) (*connect.Response[shortsv1alpha1.ListBacktestTradesResponse], error) {
	if _, _, err := privateAccess(ctx); err != nil {
		return nil, err
	}
	if s.strategyBacktests == nil {
		return nil, connect.NewError(connect.CodeNotFound, errors.New("no canonical backtest run"))
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
	offset := 0
	if tok := strings.TrimSpace(req.Msg.PageToken); tok != "" {
		n, err := strconv.Atoi(tok)
		if err != nil || n < 0 {
			return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("page_token is not valid"))
		}
		offset = n
	}
	_, ok, err := s.strategyBacktests.ReadCanonicalBacktest(ctx, runID)
	if err != nil && !errors.Is(err, shortsstore.ErrStrategyBacktestSchema) {
		s.logger.Errorf("ListBacktestTrades: reading run %d failed: %v", runID, err)
		return nil, connect.NewError(connect.CodeUnavailable, errors.New("trades are not available"))
	}
	if !ok {
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("no canonical backtest run %d", runID))
	}
	rows, err := s.strategyBacktests.ReadBacktestTrades(ctx, runID)
	if err != nil && !errors.Is(err, shortsstore.ErrStrategyBacktestSchema) {
		s.logger.Errorf("ListBacktestTrades: trades of run %d failed: %v", runID, err)
		return nil, connect.NewError(connect.CodeUnavailable, errors.New("trades are not available"))
	}
	code := strings.ToUpper(strings.TrimSpace(req.Msg.StockCode))
	reason := strings.TrimSpace(req.Msg.ExitReason)
	var matched []*shortsv1alpha1.BacktestTrade
	for _, t := range rows {
		if code != "" && t.StockCode != code {
			continue
		}
		if reason != "" && t.ExitReason != reason {
			continue
		}
		matched = append(matched, backtestTradeOf(t))
	}
	out := &shortsv1alpha1.ListBacktestTradesResponse{Total: int32(len(matched)), Trades: []*shortsv1alpha1.BacktestTrade{}}
	if offset > len(matched) {
		offset = len(matched)
	}
	end := offset + size
	if end > len(matched) {
		end = len(matched)
	}
	out.Trades = append(out.Trades, matched[offset:end]...)
	if end < len(matched) {
		out.NextPageToken = strconv.Itoa(end)
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
		EntryPrice:     round6(t.EntryPrice),
		EntryScore:     round6(t.EntryScore),
		ExitSignalDate: t.ExitSignalDate,
		ExitDate:       t.ExitDate,
		ExitPrice:      round6(t.ExitPrice),
		ExitReason:     t.ExitReason,
		SessionsHeld:   int32(t.SessionsHeld),
		GrossReturnPct: round6(t.GrossReturnPct),
		NetReturnPct:   round6(t.NetReturnPct),
		Flags:          t.Flags,
		Open:           t.Open,
	}
	if t.CapturedPivot != nil {
		out.CapturedPivot, out.HasCapturedPivot = round6(*t.CapturedPivot), true
	}
	return out
}

// CompareStrategies puts two or three canonical strategies side by side over the sessions
// every one of them covers. A strategy with no published run is returned in its state, with
// no curve, and no correlations are computed.
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
		run   *computedRun
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
		p := part{entry: &shortsv1alpha1.CompareEntry{
			StrategyRef: id, StrategyId: id, Name: st.Name, State: bs.state,
			Version: versionRefWith(lb.reg, lb.hash, lb.table.stateOf(lb.reg, lb.hash)),
		}}
		if bs.state == backtestStateComputed {
			c, err := s.loadComputedRun(ctx, *bs.computed)
			if err != nil {
				s.logger.Errorf("CompareStrategies: run of %s failed: %v", id, err)
				return nil, connect.NewError(connect.CodeUnavailable, errors.New("backtests are not available"))
			}
			p.run = &c
		}
		parts = append(parts, p)
	}

	out := &shortsv1alpha1.CompareStrategiesResponse{}
	computed := 0
	for _, p := range parts {
		if p.run != nil {
			computed++
		}
	}
	if computed != len(parts) {
		for _, p := range parts {
			out.Entries = append(out.Entries, p.entry)
		}
		return connect.NewResponse(out), nil
	}

	// The common window: the sessions every compared curve covers.
	from, to := parts[0].run.chain.days[0].date, parts[0].run.chain.days[len(parts[0].run.chain.days)-1].date
	for _, p := range parts[1:] {
		days := p.run.chain.days
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
		sub := daysBetween(p.run.chain.days, from, to)
		if len(sub) == 0 {
			return nil, connect.NewError(connect.CodeFailedPrecondition, errors.New("the compared strategies share no session"))
		}
		series := backtest.Series{Basis: backtest.BasisTotal, Curve: curveOf(sub)}
		f := backtest.WindowOf("common", "Common window", series, p.run.cash, "")
		trades := windowTrades(p.run.trades, p.run.paperTrades, p.run.chain.liveFrom, p.run.chain.hasLive, p.run.chain.paper != nil)
		p.entry.Window = windowMetricsOf(f, sub, trades)
		p.entry.Series = seriesOf(rebasedDays(sub), keptSessions(sub, troughOf(sub)))
		returns[p.entry.StrategyId] = dailyReturns(sub)
		out.Entries = append(out.Entries, p.entry)
	}
	for i := 0; i < len(ids); i++ {
		for j := i + 1; j < len(ids); j++ {
			corr, days, ok := correlate(returns[ids[i]], returns[ids[j]])
			out.Correlations = append(out.Correlations, &shortsv1alpha1.StrategyCorrelation{
				A: ids[i], B: ids[j], Correlation: round6(corr), HasCorrelation: ok, Days: int32(days),
			})
		}
	}
	return connect.NewResponse(out), nil
}

// rebasedDays is a span with its equity rebased to 100,000 on its first session, and no
// benchmark or reference (their levels are not comparable across strategies).
func rebasedDays(days []chainDay) []chainDay {
	out := make([]chainDay, len(days))
	if len(days) == 0 {
		return out
	}
	base := days[0].equity
	for k, d := range days {
		out[k] = d
		out[k].equity = d.equity / base * 100000
		out[k].bench, out[k].hasBench = 0, false
		out[k].ref, out[k].hasRef = 0, false
	}
	return out
}

// dailyReturns is each session's return on the previous one, keyed by session.
func dailyReturns(days []chainDay) map[civil.Date]float64 {
	out := make(map[civil.Date]float64, len(days))
	for k := 1; k < len(days); k++ {
		if days[k-1].equity > 0 {
			out[days[k].date] = days[k].equity/days[k-1].equity - 1
		}
	}
	return out
}

// correlate is the Pearson correlation of two return series over the sessions both hold.
// ok is false when the overlap is too short or one series has no variance.
func correlate(a, b map[civil.Date]float64) (float64, int, bool) {
	var xs, ys []float64
	for d, x := range a {
		if y, ok := b[d]; ok {
			xs = append(xs, x)
			ys = append(ys, y)
		}
	}
	n := len(xs)
	if n < 2 {
		return 0, n, false
	}
	var mx, my float64
	for i := range xs {
		mx += xs[i]
		my += ys[i]
	}
	mx /= float64(n)
	my /= float64(n)
	var sxy, sxx, syy float64
	for i := range xs {
		dx, dy := xs[i]-mx, ys[i]-my
		sxy += dx * dy
		sxx += dx * dx
		syy += dy * dy
	}
	if sxx == 0 || syy == 0 {
		return 0, n, false
	}
	return sxy / math.Sqrt(sxx*syy), n, true
}
