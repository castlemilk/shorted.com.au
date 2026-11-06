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

// The pure side of the backtest rpcs: the chained curve of a published run (5.8), the decimation
// of its series (5.18), the period tables (5.10), the window trade counts (5.9) and the replay
// agreement (5.13). Nothing here reads a store, so every rule is tested on its own.

// weeklyPointCap bounds a served series: at most this many points reach the wire (5.18).
const weeklyPointCap = 500

// evidenceMonthCap bounds the evidence card's month-end curve (5.18: at most 96 points).
const evidenceMonthCap = 96

// paperMinSessions and paperMinClosed are the paper track's too-short thresholds (5.9).
const (
	paperMinSessions = 63
	paperMinClosed   = 10
)

// minCorrelationDays is the fewest overlapping daily returns a correlation is stated over.
const minCorrelationDays = 20

// storedSeries is a run's series document, as the job writes it: parallel arrays of the daily
// sessions. E, B and R are index levels for equity, XJT and the reference; DD and X are fractions
// (drawdown from the peak, and invested over equity). R is zero on runs published before the
// reference was written into the records; those carry no daily reference.
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

// chainedRun is a published run's curve after the chaining of 5.8: the in-sample sessions before
// live_from, then the paper track rebased onto the last in-sample session.
type chainedRun struct {
	// days are the chained sessions: the in-sample ones, then the paper track's.
	days []chainDay
	// bt and paper are the two curves the backtest package's Windows chains. paper is nil when no
	// paper session chains (or the run has no live_from).
	bt    backtest.Series
	paper *backtest.Series
	// liveFrom is the first session of the paper track; hasLive is false for a run with no live
	// split, which has no in-sample/paper boundary.
	liveFrom civil.Date
	hasLive  bool
}

// buildChainedRun chains a run's stored series with its paper track. inSampleUntil is the run's
// in_sample_until (live_from minus one day); "" means the run has no live split.
func buildChainedRun(series storedSeries, inSampleUntil string, paper []shortsstore.PaperEquityRow) (chainedRun, error) {
	n := len(series.D)
	if n == 0 || len(series.E) != n || len(series.B) != n || len(series.X) != n {
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
	out.liveFrom = dates[n-1].AddDays(1)
	if inSampleUntil != "" {
		until, err := civil.ParseDate(inSampleUntil)
		if err != nil {
			return chainedRun{}, fmt.Errorf("in_sample_until %q: %w", inSampleUntil, err)
		}
		out.liveFrom, out.hasLive = until.AddDays(1), true
	}

	// The in-sample sessions are the backtest's before live_from. Without a live split every
	// session is in-sample.
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
			ref: refAt(series, k), hasRef: refAt(series, k) > 0,
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
		// Chain is the 5.8 formula. A paper track that cannot be chained (no session on or after
		// live_from, or no in-sample session to start from) is left out, not guessed.
		if _, err := backtest.Chain(out.bt, ps, out.liveFrom); err == nil {
			out.paper = &ps
			days = append(days, paperDays(paper, pc, out.liveFrom, series, i)...)
		}
	}
	out.days = days
	return out, nil
}

// refAt is the stored reference level of session k, or zero when the series carries none.
func refAt(series storedSeries, k int) float64 {
	if k < len(series.R) {
		return series.R[k]
	}
	return 0
}

// paperDays are the paper track's sessions on or after live_from, rebased as Chain rebases them:
// E(t) = E_bt(live_from-1) x paper(t) / paper(start). The paper track's own first session is the
// base of the rebase, and the last in-sample session carries the level the chain starts from.
func paperDays(paper []shortsstore.PaperEquityRow, pc backtest.Curve, liveFrom civil.Date, series storedSeries, i int) []chainDay {
	j := sort.Search(len(pc.Dates), func(m int) bool { return !pc.Dates[m].Before(liveFrom) })
	base := series.E[i-1]
	start := pc.Values[j]
	out := make([]chainDay, 0, len(pc.Dates)-j)
	for m := j; m < len(pc.Dates); m++ {
		row := paper[m]
		day := chainDay{
			date:     pc.Dates[m],
			equity:   base * pc.Values[m] / start,
			recorded: true,
		}
		if row.Equity > 0 {
			day.exposure = (row.Equity - row.Cash) / row.Equity
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

// keptSessions is the decimation of 5.18: the last session of each ISO week, plus the must-keep
// sessions (the first and last sessions, and whichever the caller names: each window's peak and
// trough, and the sessions either side of live_from). The result is at most weeklyPointCap points.
// When the weekly list is too long, the free weeks are thinned by a stride that leaves room for
// every must-keep session, so the count never exceeds the cap.
func keptSessions(days []chainDay, must []int) []int {
	n := len(days)
	if n == 0 {
		return nil
	}
	mustSet := map[int]bool{0: true, n - 1: true}
	for _, m := range must {
		if m >= 0 && m < n {
			mustSet[m] = true
		}
	}
	var free []int
	for k := 0; k < n; k++ {
		if (k == n-1 || isoWeekKey(days[k].date) != isoWeekKey(days[k+1].date)) && !mustSet[k] {
			free = append(free, k)
		}
	}
	budget := weeklyPointCap - len(mustSet)
	if budget < 0 {
		budget = 0
	}
	picked := free
	if len(free) > budget {
		picked = nil
		if budget > 0 {
			stride := (len(free) + budget - 1) / budget
			for p := 0; p < len(free); p += stride {
				picked = append(picked, free[p])
			}
		}
	}
	out := make([]int, 0, len(mustSet)+len(picked))
	for k := range mustSet {
		out = append(out, k)
	}
	out = append(out, picked...)
	sort.Ints(out)
	return out
}

// round0, round2 and round4 round to whole dollars and to two and four decimals.
func round0(v float64) float64 { return math.Round(v) }
func round2(v float64) float64 { return math.Round(v*1e2) / 1e2 }
func round4(v float64) float64 { return math.Round(v*1e4) / 1e4 }

// seriesOf turns the kept sessions of a served span into series points. The drawdown is taken on
// the served span itself, so a window's drawn fall reaches its own reported maximum. The figures
// are rounded to what a reader can use: whole A$ for equity, two decimals elsewhere, which keeps a
// 500-point series near 50 KB.
func seriesOf(served []chainDay, idx []int) []*shortsv1alpha1.SeriesPoint {
	dd, _ := drawdowns(served)
	out := make([]*shortsv1alpha1.SeriesPoint, 0, len(idx))
	for _, k := range idx {
		d := served[k]
		p := &shortsv1alpha1.SeriesPoint{
			Date:        d.date.String(),
			Equity:      round0(d.equity),
			DrawdownPct: round2(dd[k] * 100),
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

// periodRow is one year or month of the chained curve: the sessions it spans and the session its
// return is measured from (the last session of the period before, or the first session).
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

// periodReturn is the return of a period measured from its base. The benchmark and the reference
// are reported only where both ends carry their level.
func periodReturn(days []chainDay, p periodRow) (strategy, bench float64, hasBench bool, ref float64, hasRef bool) {
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

// coverageMeasure names the measure an annual row's coverage uses (5.11, 1.5). A measured run uses
// the qualifying measure; an ASIC-reported-only run (Minervini) uses all reported names, and marks
// every year before 2025 not measurable, as the cells do ("?" before 2025); an unmeasurable run has
// no coverage.
const (
	measureQualifying      = "qualifying_5pct_short"
	measureAllReported     = "all_reported"
	measureNotMeasured     = "not_measurable"
	coverageMeasurableFrom = 2025
)

// annualCoverage is the coverage of one year under the measure the run's survivorship names.
func annualCoverage(year int, measurement string, cov backtest.Coverage) (pct float64, measurable bool, measure string) {
	switch measurement {
	case backtest.MeasurementMeasured:
		c, ok := coverageByKey(cov.Qualifying.Years)[fmt.Sprintf("%04d", year)]
		if ok && c.Qualifying > 0 {
			return round2(c.Ratio * 100), true, measureQualifying
		}
		return 0, false, measureQualifying
	case backtest.MeasurementASICOnly:
		if year < coverageMeasurableFrom {
			return 0, false, measureNotMeasured
		}
		c, ok := coverageByKey(cov.AllReported.Years)[fmt.Sprintf("%04d", year)]
		if ok && c.Qualifying > 0 {
			return round2(c.Ratio * 100), true, measureAllReported
		}
		return 0, false, measureAllReported
	}
	return 0, false, measureNotMeasured
}

// periodTables builds the annual and monthly tables (5.10). The first period is measured from the
// window's first session and is partial; the current period is measured to date (state to_date).
// Coverage on the annual rows follows the run's survivorship measurement.
func periodTables(days []chainDay, cov backtest.Coverage, measurement string) ([]*shortsv1alpha1.AnnualReturn, []*shortsv1alpha1.MonthlyReturn) {
	if len(days) == 0 {
		return nil, nil
	}
	latest := days[len(days)-1].date
	first := days[0].date

	var annual []*shortsv1alpha1.AnnualReturn
	for _, p := range periodsOf(days, func(d civil.Date) string { return fmt.Sprintf("%04d", d.Year) }) {
		year := days[p.first].date.Year
		strat, bench, hasBench, ref, hasRef := periodReturn(days, p)
		row := &shortsv1alpha1.AnnualReturn{
			Year: int32(year), StrategyPct: round2(strat),
			BenchmarkPct: round2(bench), HasBenchmark: hasBench,
			ReferencePct: round2(ref), HasReference: hasRef,
		}
		switch year {
		case latest.Year:
			row.State = "to_date"
			row.Months = "YTD"
		case first.Year:
			row.State = "partial"
			row.Months = fmt.Sprintf("%s-%s", monthName(first.Month), monthName(days[p.last].date.Month))
		default:
			row.State = "complete"
		}
		row.CoveragePct, row.CoverageMeasurable, row.CoverageMeasure = annualCoverage(year, measurement, cov)
		annual = append(annual, row)
	}

	var monthly []*shortsv1alpha1.MonthlyReturn
	for _, p := range periodsOf(days, func(d civil.Date) string { return fmt.Sprintf("%04d-%02d", d.Year, d.Month) }) {
		d := days[p.first].date
		strat, bench, hasBench, ref, hasRef := periodReturn(days, p)
		row := &shortsv1alpha1.MonthlyReturn{
			Year: int32(d.Year), Month: int32(d.Month), StrategyPct: round2(strat),
			BenchmarkPct: round2(bench), HasBenchmark: hasBench,
			ReferencePct: round2(ref), HasReference: hasRef,
		}
		switch {
		case p.key == fmt.Sprintf("%04d-%02d", latest.Year, latest.Month):
			row.State = "to_date"
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

// windowTrade is one trade's share in a window's figures: its exit session and, for an in-sample
// trade, its net return. A paper trade carries no net return on this path, so it does not count
// toward a win rate.
type windowTrade struct {
	exit   civil.Date
	net    float64
	hasNet bool
}

// closedAndWinRate counts the trades that exited inside [from, to]. The win rate is over the trades
// that carry a net return, and is withheld when the window holds paper sessions (paper trades carry
// no net return until the paper track records one).
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

// replayPaperTrade is one paper trade as the replay compares it.
type replayPaperTrade struct {
	code, entry, exit string
	open              bool
}

// replayAgreement compares the run's trades with the paper track (5.13). Only entries in
// [live_from, end] are compared, where end is the earlier of the run's window end and the paper
// track's last session: a trade the paper track has not reached yet is not compared. The count is
// over the union of the two sides, so a paper trade the run does not have is a disagreement. A run
// trade open at the run's end agrees with a paper trade that is still open or that exits after the
// run's window end. A run whose fundamentals policy is not the live one is never compared.
func replayAgreement(run []shortsstore.BacktestTradeRow, paper []shortsstore.PaperTradeRow, liveFrom civil.Date, hasLive bool, runEnd, paperEnd civil.Date, comparable bool) string {
	if !comparable {
		return "Replay not comparable: different fundamentals policy"
	}
	if !hasLive {
		return ""
	}
	if paperEnd.IsZero() {
		return "No paper track to compare yet"
	}
	end := runEnd
	if paperEnd.Before(end) {
		end = paperEnd
	}
	inRange := func(entry civil.Date) bool { return !entry.Before(liveFrom) && !entry.After(end) }

	var ps []replayPaperTrade
	for _, p := range paper {
		entry, err := civil.ParseDate(p.EntryDate)
		if err != nil || !inRange(entry) {
			continue
		}
		ps = append(ps, replayPaperTrade{code: p.StockCode, entry: p.EntryDate, exit: p.ExitDate, open: p.ExitDate == ""})
	}
	used := make([]bool, len(ps))
	total, agree := 0, 0
	for _, t := range run {
		entry, err := civil.ParseDate(t.EntryDate)
		if err != nil || !inRange(entry) {
			continue
		}
		// A run trade that exits after the paper track's last session has not happened on the paper
		// side yet: it is not compared.
		if !t.Open && t.ExitDate != "" {
			exit, err := civil.ParseDate(t.ExitDate)
			if err == nil && exit.After(end) {
				continue
			}
		}
		total++
		matched := false
		for i, p := range ps {
			if used[i] || p.code != t.StockCode || p.entry != t.EntryDate {
				continue
			}
			var ok bool
			if t.Open {
				ok = p.open || (p.exit != "" && p.exit > runEndString(runEnd))
			} else {
				ok = p.exit == t.ExitDate
			}
			if ok {
				used[i], matched = true, true
				break
			}
		}
		if matched {
			agree++
		}
	}
	for i := range ps {
		if !used[i] {
			total++
		}
	}
	switch {
	case total == 0:
		return fmt.Sprintf("No trades entered between %s and %s to compare", liveFrom, end)
	case agree == total:
		return fmt.Sprintf("Replay agrees: %d of %d trades", agree, total)
	default:
		return fmt.Sprintf("Replay diverges: %d of %d trades agree", agree, total)
	}
}

// runEndString is the run's end as the YYYY-MM-DD string the paper exits are compared by.
func runEndString(d civil.Date) string { return d.String() }

// tradeSummaryOf is the public trade summary of the closed trades the caller passes (the in-sample
// trades, by 1.5). Each figure carries a has_ flag that is false when no trade supports it.
func tradeSummaryOf(run []shortsstore.BacktestTradeRow) *shortsv1alpha1.TradeSummary {
	out := &shortsv1alpha1.TradeSummary{ExitsByReason: map[string]int32{}}
	var wins, losses int
	var winSum, lossSum, holdSum float64
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
		if !out.HasBest || t.NetReturnPct > out.BestPct {
			out.BestPct, out.HasBest = round2(t.NetReturnPct), true
		}
		if !out.HasWorst || t.NetReturnPct < out.WorstPct {
			out.WorstPct, out.HasWorst = round2(t.NetReturnPct), true
		}
	}
	if out.Closed > 0 {
		out.AvgHoldSessions = round2(holdSum / float64(out.Closed))
		out.HasAvgHold = true
		out.WinRatePct = round2(float64(wins) / float64(out.Closed) * 100)
		out.HasWinRate = true
	}
	if wins > 0 {
		out.AvgWinPct, out.HasAvgWin = round2(winSum/float64(wins)), true
	}
	if losses > 0 {
		out.AvgLossPct, out.HasAvgLoss = round2(lossSum/float64(losses)), true
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
		out.ReturnPct = round2((rows[len(rows)-1].Equity/rows[0].Equity - 1) * 100)
		out.HasReturn = true
	}
	out.TooShort = len(rows) < paperMinSessions || int(out.ClosedTrades) < paperMinClosed
	return out
}

// monthEnds are the last session of each month, at most cap of them, the newest kept.
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

// correlate is the Pearson correlation of two return series over the sessions both hold. The
// overlap is taken in date order, so the result never depends on map iteration. ok is false when
// the overlap is shorter than minCorrelationDays or one series has no variance.
func correlate(a, b map[civil.Date]float64) (float64, int, bool) {
	dates := make([]civil.Date, 0, len(a))
	for d := range a {
		if _, ok := b[d]; ok {
			dates = append(dates, d)
		}
	}
	sort.Slice(dates, func(i, j int) bool { return dates[i].Before(dates[j]) })
	n := len(dates)
	if n < minCorrelationDays {
		return 0, n, false
	}
	var mx, my float64
	for _, d := range dates {
		mx += a[d]
		my += b[d]
	}
	mx /= float64(n)
	my /= float64(n)
	var sxy, sxx, syy float64
	for _, d := range dates {
		dx, dy := a[d]-mx, b[d]-my
		sxy += dx * dy
		sxx += dx * dx
		syy += dy * dy
	}
	if sxx == 0 || syy == 0 {
		return 0, n, false
	}
	return sxy / math.Sqrt(sxx*syy), n, true
}
