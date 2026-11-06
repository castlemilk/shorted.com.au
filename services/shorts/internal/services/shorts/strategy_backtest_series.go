package shorts

import (
	"fmt"
	"math"
	"sort"
	"time"

	"cloud.google.com/go/civil"

	shortsv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/shorts/v1alpha1"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/backtest"
	shortsstore "github.com/castlemilk/shorted.com.au/services/shorts/internal/store/shorts"
)

// The pure side of the backtest rpcs: the chained curve of a published run (5.8), the
// weekly decimation of its series (5.18), the period tables (5.10), the window trade
// counts (5.9) and the replay agreement (5.13). Nothing here reads a store, so every rule
// is tested on its own.

// weeklyPointCap bounds a series: at most this many points reach the wire (5.18).
const weeklyPointCap = 500

// evidenceMonthCap bounds the evidence card's month-end curve (5.18: at most 96 points).
const evidenceMonthCap = 96

// paperMinSessions and paperMinClosed are the paper track's too-short thresholds (5.9).
const (
	paperMinSessions = 63
	paperMinClosed   = 10
)

// storedSeries is a run's series document, as the job writes it: parallel arrays of the
// daily sessions. E, B and R are index levels for equity, XJT and the reference; DD and
// X are fractions (drawdown from the peak, and invested over equity).
type storedSeries struct {
	D  []string  `json:"d"`
	E  []float64 `json:"e"`
	B  []float64 `json:"b"`
	R  []float64 `json:"r"`
	DD []float64 `json:"dd"`
	X  []float64 `json:"x"`
}

// chainDay is one session of the chained curve the API serves.
type chainDay struct {
	date     civil.Date
	equity   float64
	bench    float64
	hasBench bool
	ref      float64
	hasRef   bool
	// exposure is invested over equity, as a fraction.
	exposure float64
	// recorded marks a paper-track session, recorded after live_from.
	recorded bool
}

// chainedRun is a published run's curve after the chaining of 5.8: the in-sample sessions
// before live_from, then the paper track rebased onto the last in-sample session.
type chainedRun struct {
	days []chainDay
	// bt and paper are the two curves the backtest package's Windows chains. paper is nil
	// when no paper session is recorded (or the run has no live_from), and Windows then
	// ends its curve at the freeze.
	bt    backtest.Series
	paper *backtest.Series
	// liveFrom is the first session of the paper track; hasLive is false for a run with no
	// live_from, which has no in-sample/paper split.
	liveFrom civil.Date
	hasLive  bool
	// paperRows are the paper track's rows the chain used, for trade and exposure figures.
	paperRows []shortsstore.PaperEquityRow
}

// buildChainedRun chains a run's stored series with its paper track. inSampleUntil is the
// run's in_sample_until (live_from minus one day); "" means the run has no live split.
func buildChainedRun(series storedSeries, inSampleUntil string, paper []shortsstore.PaperEquityRow) (chainedRun, error) {
	n := len(series.D)
	if n == 0 || len(series.E) != n || len(series.B) != n || len(series.R) != n || len(series.X) != n {
		return chainedRun{}, fmt.Errorf("the series document is malformed: %d dates, %d equity points", n, len(series.E))
	}
	dates := make([]civil.Date, n)
	for k, s := range series.D {
		d, err := civil.ParseDate(s)
		if err != nil {
			return chainedRun{}, fmt.Errorf("the series date %q: %w", s, err)
		}
		dates[k] = d
	}
	out := chainedRun{
		bt: backtest.Series{Basis: backtest.BasisTotal, Curve: backtest.Curve{Dates: dates, Values: series.E}},
	}
	last := dates[n-1]
	out.liveFrom = last.AddDays(1)
	if inSampleUntil != "" {
		until, err := civil.ParseDate(inSampleUntil)
		if err != nil {
			return chainedRun{}, fmt.Errorf("in_sample_until %q: %w", inSampleUntil, err)
		}
		out.liveFrom, out.hasLive = until.AddDays(1), true
	}

	// The in-sample sessions are the backtest's before live_from. Without a live split
	// every session is in-sample.
	i := n
	if out.hasLive {
		i = sort.Search(n, func(k int) bool { return !dates[k].Before(out.liveFrom) })
	}
	if i == 0 {
		return chainedRun{}, fmt.Errorf("the run has no in-sample session before live_from %s", out.liveFrom)
	}
	days := make([]chainDay, 0, n)
	for k := 0; k < i; k++ {
		days = append(days, chainDay{
			date: dates[k], equity: series.E[k],
			bench: series.B[k], hasBench: series.B[k] > 0,
			ref: series.R[k], hasRef: series.R[k] > 0,
			exposure: series.X[k],
		})
	}

	if out.hasLive && len(paper) > 0 {
		pc := backtest.Curve{}
		for _, row := range paper {
			d, err := civil.ParseDate(row.AsOf)
			if err != nil {
				return chainedRun{}, fmt.Errorf("the paper date %q: %w", row.AsOf, err)
			}
			pc.Dates = append(pc.Dates, d)
			pc.Values = append(pc.Values, row.Equity)
		}
		ps := backtest.Series{Basis: backtest.BasisTotal, Curve: pc}
		// Chain is the 5.8 formula. A paper track that cannot be chained (no session on or
		// after live_from, or no in-sample session to start from) is left out, not guessed.
		if _, err := backtest.Chain(out.bt, ps, out.liveFrom); err == nil {
			out.paper = &ps
			out.paperRows = paper
			days = append(days, paperDays(paper, pc, out.liveFrom, series, i)...)
		}
	}
	out.days = days
	return out, nil
}

// paperDays are the paper track's sessions on or after live_from, rebased as Chain
// rebases them: equity E(t) = E_bt(live_from-1) x paper(t) / paper(start). The benchmark
// is rebased the same way when the paper track records one; the reference is not recorded
// after the freeze, so those sessions carry none.
func paperDays(paper []shortsstore.PaperEquityRow, pc backtest.Curve, liveFrom civil.Date, series storedSeries, i int) []chainDay {
	j := sort.Search(len(pc.Dates), func(m int) bool { return !pc.Dates[m].Before(liveFrom) })
	base := series.E[i-1]
	start := pc.Values[j]
	baseBench := series.B[i-1]
	var startBench float64
	if paper[j].Benchmark != nil {
		startBench = *paper[j].Benchmark
	}
	out := make([]chainDay, 0, len(pc.Dates)-j)
	for m := j; m < len(pc.Dates); m++ {
		row := paper[m]
		day := chainDay{
			date:     pc.Dates[m],
			equity:   base * pc.Values[m] / start,
			exposure: 0,
			recorded: true,
		}
		if row.Equity > 0 {
			day.exposure = (row.Equity - row.Cash) / row.Equity
		}
		if row.Benchmark != nil && *row.Benchmark > 0 && startBench > 0 && baseBench > 0 {
			day.bench, day.hasBench = baseBench**row.Benchmark/startBench, true
		}
		out = append(out, day)
	}
	return out
}

// drawdowns is each session's fall from the highest equity so far, as a fraction (zero or
// negative), and the index of the deepest fall (-1 when the curve never falls).
func drawdowns(days []chainDay) (dd []float64, trough int) {
	dd = make([]float64, len(days))
	trough = -1
	peak := math.Inf(-1)
	deepest := 0.0
	for k, d := range days {
		if d.equity > peak {
			peak = d.equity
		}
		dd[k] = d.equity/peak - 1
		if dd[k] < deepest {
			deepest, trough = dd[k], k
		}
	}
	return dd, trough
}

// isoWeekKey groups sessions by ISO week.
func isoWeekKey(d civil.Date) string {
	y, w := time.Date(d.Year, d.Month, d.Day, 0, 0, 0, 0, time.UTC).ISOWeek()
	return fmt.Sprintf("%04d-W%02d", y, w)
}

// keptSessions is the decimation of 5.18: the last session of each ISO week, the first and
// last sessions, and the trough. When the result would exceed the cap, every k-th week is
// kept, and the first, last and trough sessions always are.
func keptSessions(days []chainDay, trough int) []int {
	n := len(days)
	if n == 0 {
		return nil
	}
	must := map[int]bool{0: true, n - 1: true}
	if trough >= 0 {
		must[trough] = true
	}
	var weekly []int
	for k := 0; k < n; k++ {
		if k == n-1 || isoWeekKey(days[k].date) != isoWeekKey(days[k+1].date) {
			weekly = append(weekly, k)
		}
	}
	for m := range must {
		if !containsInt(weekly, m) {
			weekly = append(weekly, m)
		}
	}
	sort.Ints(weekly)
	if len(weekly) <= weeklyPointCap {
		return weekly
	}
	stride := (len(weekly) + weeklyPointCap - 1) / weeklyPointCap
	out := make([]int, 0, weeklyPointCap)
	for p, k := range weekly {
		if p%stride == 0 || must[k] {
			out = append(out, k)
		}
	}
	return out
}

func containsInt(xs []int, x int) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}

// seriesOf turns the kept sessions into series points. The drawdown of each is taken on
// the chained curve, so the drawn fall reaches the reported maximum. The figures are rounded
// to the precision a reader can use (cents of A$, two decimals on the index levels, four on
// the drawdown): a series of about 400 points is what the 60 KB payload budget is spent on.
func seriesOf(days []chainDay, idx []int) []*shortsv1alpha1.SeriesPoint {
	dd, _ := drawdowns(days)
	out := make([]*shortsv1alpha1.SeriesPoint, 0, len(idx))
	for _, k := range idx {
		d := days[k]
		p := &shortsv1alpha1.SeriesPoint{
			Date:        d.date.String(),
			Equity:      round2(d.equity),
			DrawdownPct: round4(dd[k] * 100),
			ExposurePct: round2(d.exposure * 100),
			Recorded:    d.recorded,
		}
		if d.hasBench {
			p.Benchmark = round2(d.bench)
		}
		if d.hasRef {
			p.Reference = round2(d.ref)
		}
		out = append(out, p)
	}
	return out
}

// round2 and round4 round to two and four decimals.
func round2(v float64) float64 { return math.Round(v*1e2) / 1e2 }
func round4(v float64) float64 { return math.Round(v*1e4) / 1e4 }

// round6 rounds to the millionth, the precision the stored series keeps.
func round6(v float64) float64 {
	return math.Round(v*1e6) / 1e6
}

// periodRow is one year or month of the chained curve: the sessions it spans and their
// base (the last session of the period before, or the window's first session).
type periodRow struct {
	key   string
	first int
	last  int
	base  int
}

// periodsOf groups the chained sessions by key (a year or a month), in order.
func periodsOf(days []chainDay, key func(civil.Date) string) []periodRow {
	var out []periodRow
	for k, d := range days {
		kk := key(d.date)
		if len(out) == 0 || out[len(out)-1].key != kk {
			base := 0
			if len(out) > 0 {
				base = out[len(out)-1].last
			}
			out = append(out, periodRow{key: kk, first: k, base: base})
		}
		out[len(out)-1].last = k
	}
	return out
}

// periodReturn is the return of a period measured from its base, and whether the benchmark
// and the reference are measured over the same span.
func periodReturn(days []chainDay, p periodRow) (strategy float64, bench float64, hasBench bool, ref float64, hasRef bool) {
	b, l := days[p.base], days[p.last]
	strategy = (l.equity/b.equity - 1) * 100
	if b.hasBench && l.hasBench {
		bench, hasBench = (l.bench/b.bench-1)*100, true
	}
	if b.hasRef && l.hasRef {
		ref, hasRef = (l.ref/b.ref-1)*100, true
	}
	return strategy, bench, hasBench, ref, hasRef
}

// periodTables builds the annual and monthly tables (5.10). The first period is measured from
// the window's first session and is partial; the current period is measured to date and is
// not elapsed. Coverage on the annual rows is the qualifying measure's, which is what the
// table prints (the coverage tables carry both).
func periodTables(days []chainDay, cov backtest.Coverage) ([]*shortsv1alpha1.AnnualReturn, []*shortsv1alpha1.MonthlyReturn) {
	if len(days) == 0 {
		return nil, nil
	}
	latest := days[len(days)-1].date
	first := days[0].date

	covYears := coverageByKey(cov.Qualifying.Years)

	var annual []*shortsv1alpha1.AnnualReturn
	for _, p := range periodsOf(days, func(d civil.Date) string { return fmt.Sprintf("%04d", d.Year) }) {
		year := days[p.first].date.Year
		strat, bench, hasBench, ref, hasRef := periodReturn(days, p)
		row := &shortsv1alpha1.AnnualReturn{
			Year: int32(year), StrategyPct: round6(strat),
			BenchmarkPct: round6(bench), HasBenchmark: hasBench,
			ReferencePct: round6(ref), HasReference: hasRef,
		}
		switch year {
		case latest.Year:
			row.State = "not_elapsed"
			row.Months = "YTD"
		case first.Year:
			row.State = "partial"
			row.Months = fmt.Sprintf("%s-%s", monthName(first.Month), monthName(days[p.last].date.Month))
		default:
			row.State = "complete"
		}
		if c, ok := covYears[p.key]; ok && c.Qualifying > 0 {
			row.CoveragePct, row.CoverageMeasurable = round6(c.Ratio*100), true
		}
		annual = append(annual, row)
	}

	var monthly []*shortsv1alpha1.MonthlyReturn
	for _, p := range periodsOf(days, func(d civil.Date) string { return fmt.Sprintf("%04d-%02d", d.Year, d.Month) }) {
		d := days[p.first].date
		strat, bench, hasBench, ref, hasRef := periodReturn(days, p)
		row := &shortsv1alpha1.MonthlyReturn{
			Year: int32(d.Year), Month: int32(d.Month), StrategyPct: round6(strat),
			BenchmarkPct: round6(bench), HasBenchmark: hasBench,
			ReferencePct: round6(ref), HasReference: hasRef,
		}
		switch {
		case p.key == fmt.Sprintf("%04d-%02d", latest.Year, latest.Month):
			row.State = "not_elapsed"
			row.Label = "MTD"
		case p.key == fmt.Sprintf("%04d-%02d", first.Year, first.Month):
			row.State = "partial"
			row.Label = fmt.Sprintf("from %d %s", first.Day, monthName(first.Month))
		default:
			row.State = "complete"
		}
		monthly = append(monthly, row)
	}
	return annual, monthly
}

// coverageByKey indexes a measure's periods by their key.
func coverageByKey(periods []backtest.CoveragePeriod) map[string]backtest.CoveragePeriod {
	out := make(map[string]backtest.CoveragePeriod, len(periods))
	for _, p := range periods {
		out[p.Period] = p
	}
	return out
}

func monthName(m time.Month) string {
	return m.String()[:3]
}

// windowTrade is one trade's share in the window figures: its exit session and, for an
// in-sample trade, its net return. A paper trade carries no net return here, so it does not
// count toward a win rate.
type windowTrade struct {
	exit     civil.Date
	net      float64
	hasNet   bool
	inSample bool
}

// windowTrades is the chained trades: the in-sample trades that closed before live_from
// (the paper track replaces the rest) and, when a paper track is recorded, its closed
// trades.
func windowTrades(run []shortsstore.BacktestTradeRow, paper []shortsstore.PaperTradeRow, liveFrom civil.Date, hasLive, hasPaper bool) []windowTrade {
	var out []windowTrade
	for _, t := range run {
		if t.Open || t.ExitDate == "" {
			continue
		}
		exit, err := civil.ParseDate(t.ExitDate)
		if err != nil || (hasLive && !exit.Before(liveFrom)) {
			continue
		}
		out = append(out, windowTrade{exit: exit, net: t.NetReturnPct / 100, hasNet: true, inSample: true})
	}
	if !hasPaper {
		return out
	}
	for _, t := range paper {
		if t.Status != "closed" || t.ExitDate == "" {
			continue
		}
		exit, err := civil.ParseDate(t.ExitDate)
		if err != nil {
			continue
		}
		out = append(out, windowTrade{exit: exit})
	}
	return out
}

// closedAndWinRate counts the trades that exited inside [from, to]. The win rate is over the
// in-sample trades only, and is withheld (hasWin false) when the window holds paper sessions,
// since the paper trades carry no net return.
func closedAndWinRate(trades []windowTrade, from, to civil.Date, windowHasPaper bool) (closed int, winRate float64, hasWin bool) {
	var wins, withNet int
	for _, t := range trades {
		if t.exit.Before(from) || t.exit.After(to) {
			continue
		}
		closed++
		if t.hasNet {
			withNet++
			if t.net > 0 {
				wins++
			}
		}
	}
	if windowHasPaper || withNet == 0 {
		return closed, 0, false
	}
	return closed, float64(wins) / float64(withNet) * 100, true
}

// replayAgreement compares the run's trades since live_from with the paper track on (code,
// entry date, exit date) (5.13). comparable is false when the run's fundamentals policy is
// not the live one: such a run is never compared.
func replayAgreement(run []shortsstore.BacktestTradeRow, paper []shortsstore.PaperTradeRow, liveFrom civil.Date, hasLive, comparable bool) string {
	if !comparable {
		return "Replay not comparable: different fundamentals policy"
	}
	if !hasLive {
		return ""
	}
	type key struct{ code, entry, exit string }
	have := map[key]int{}
	for _, p := range paper {
		have[key{p.StockCode, p.EntryDate, p.ExitDate}]++
	}
	total, agree := 0, 0
	for _, t := range run {
		entry, err := civil.ParseDate(t.EntryDate)
		if err != nil || entry.Before(liveFrom) {
			continue
		}
		total++
		k := key{t.StockCode, t.EntryDate, t.ExitDate}
		if have[k] > 0 {
			have[k]--
			agree++
		}
	}
	switch {
	case total == 0:
		return fmt.Sprintf("No trades since %s to compare", liveFrom)
	case agree == total:
		return fmt.Sprintf("Replay agrees: %d of %d trades", agree, total)
	default:
		return fmt.Sprintf("Replay diverges: %d of %d trades agree", agree, total)
	}
}

// tradeSummaryOf is the public trade summary of a run's in-sample trades (5.10).
func tradeSummaryOf(run []shortsstore.BacktestTradeRow) *shortsv1alpha1.TradeSummary {
	out := &shortsv1alpha1.TradeSummary{ExitsByReason: map[string]int32{}}
	var wins, losses int
	var winSum, lossSum, holdSum float64
	first := true
	for _, t := range run {
		if t.ExitReason != "" {
			out.ExitsByReason[t.ExitReason]++
		}
		if t.Open {
			out.OpenAtEnd++
			continue
		}
		out.Closed++
		holdSum += float64(t.SessionsHeld)
		if t.NetReturnPct > 0 {
			wins++
			winSum += t.NetReturnPct
		} else {
			losses++
			lossSum += t.NetReturnPct
		}
		if first || t.NetReturnPct > out.BestPct {
			out.BestPct = round6(t.NetReturnPct)
		}
		if first || t.NetReturnPct < out.WorstPct {
			out.WorstPct = round6(t.NetReturnPct)
		}
		first = false
	}
	if out.Closed > 0 {
		out.AvgHoldSessions = round6(holdSum / float64(out.Closed))
		out.WinRatePct = round6(float64(wins) / float64(out.Closed) * 100)
		out.HasWinRate = true
	}
	if wins > 0 {
		out.AvgWinPct = round6(winSum / float64(wins))
	}
	if losses > 0 {
		out.AvgLossPct = round6(lossSum / float64(losses))
	}
	return out
}

// paperSummaryOf is the paper track since live_from, with its too-short flag.
func paperSummaryOf(since string, rows []shortsstore.PaperEquityRow, trades []shortsstore.PaperTradeRow) *shortsv1alpha1.PaperTrackSummary {
	out := &shortsv1alpha1.PaperTrackSummary{Since: since, Sessions: int32(len(rows))}
	for _, t := range trades {
		switch t.Status {
		case "closed":
			out.ClosedTrades++
		case "open", "pending_exit":
			out.OpenPositions++
		}
	}
	if len(rows) >= 2 && rows[0].Equity > 0 {
		out.ReturnPct = round6((rows[len(rows)-1].Equity/rows[0].Equity - 1) * 100)
		out.HasReturn = true
	}
	out.TooShort = len(rows) < paperMinSessions || int(out.ClosedTrades) < paperMinClosed
	return out
}

// monthEnds are the last session of each month, at most evidenceMonthCap of them, the
// newest kept. The evidence card's mini curve is drawn from them.
func monthEnds(days []chainDay, cap int) []int {
	var out []int
	for k := range days {
		if k == len(days)-1 || days[k].date.Month != days[k+1].date.Month || days[k].date.Year != days[k+1].date.Year {
			out = append(out, k)
		}
	}
	if len(out) > cap {
		out = out[len(out)-cap:]
	}
	return out
}

// curveOf is the daily equity curve of a span of the chained sessions.
func curveOf(days []chainDay) backtest.Curve {
	c := backtest.Curve{Dates: make([]civil.Date, 0, len(days)), Values: make([]float64, 0, len(days))}
	for _, d := range days {
		c.Dates = append(c.Dates, d.date)
		c.Values = append(c.Values, d.equity)
	}
	return c
}
