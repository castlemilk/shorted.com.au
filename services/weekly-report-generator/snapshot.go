package main

import (
	"context"
	"math"
	"sort"
	"time"
)

// Movers algorithm v2 + shared snapshot enrichment.
//
// All three collectors (weekly, monthly, yearly) compare two period-endpoint
// snapshots. This file holds the pure computation (testable without a DB) and
// the buildSnapshot orchestrator that runs the enrichment queries.

const (
	// moverMinChange is the minimum absolute change (pp) for mover candidacy.
	moverMinChange = 0.1
	// moverMinLevel is the minimum short % level (max of current/previous) for candidacy.
	moverMinLevel = 0.5
	// moverRelativeFloor prevents tiny bases from exploding the relative-change term.
	moverRelativeFloor = 0.75
	// zScoreMinStdDev floors the stddev so near-flat histories don't produce huge z-scores.
	zScoreMinStdDev = 0.15
	// zScoreMinDeltas is the minimum number of weekly deltas needed for a meaningful z-score.
	zScoreMinDeltas = 6
	// streakMinDelta is the minimum weekly delta magnitude (pp) that counts towards a streak.
	streakMinDelta = 0.05
	// maxHistoryPoints caps the weekly history series length (~13 weeks).
	maxHistoryPoints = 13
	// marketMoveThreshold is the minimum move (pp) for the market-wide riser/faller counts.
	marketMoveThreshold = 0.01
	// industryMinStocks is the minimum shorted stocks for an industry to be reported.
	industryMinStocks = 3
	// industryMaxRows caps the industry breakdown size.
	industryMaxRows = 12
	// topListSize is the size of the top shorted list (and new-entrant window).
	topListSize = 10
)

func round2(v float64) float64 { return math.Round(v*100) / 100 }
func round1(v float64) float64 { return math.Round(v*10) / 10 }

// historyPoint is one raw shorts observation used to build weekly history.
type historyPoint struct {
	Code string
	Date time.Time
	Pct  float64
}

// isoWeekKey produces a sortable int key for an ISO (year, week).
func isoWeekKey(t time.Time) int {
	y, w := t.ISOWeek()
	return y*100 + w
}

// bucketWeeklyHistory buckets raw observations by ISO week (latest observation
// per week wins), producing oldest-first series of up to maxPoints values
// (rounded 2dp) ending at the report week.
func bucketWeeklyHistory(points []historyPoint, reportDate time.Time, maxPoints int) map[string][]float64 {
	if len(points) == 0 {
		return nil
	}
	reportKey := isoWeekKey(reportDate)

	type weekObs struct {
		date time.Time
		pct  float64
	}
	byCode := make(map[string]map[int]weekObs)
	for _, p := range points {
		key := isoWeekKey(p.Date)
		if key > reportKey {
			continue // never include weeks after the report week
		}
		weeks, ok := byCode[p.Code]
		if !ok {
			weeks = make(map[int]weekObs)
			byCode[p.Code] = weeks
		}
		if prev, ok := weeks[key]; !ok || p.Date.After(prev.date) {
			weeks[key] = weekObs{date: p.Date, pct: p.Pct}
		}
	}

	result := make(map[string][]float64, len(byCode))
	for code, weeks := range byCode {
		keys := make([]int, 0, len(weeks))
		for k := range weeks {
			keys = append(keys, k)
		}
		sort.Ints(keys)
		if len(keys) > maxPoints {
			keys = keys[len(keys)-maxPoints:]
		}
		series := make([]float64, 0, len(keys))
		for _, k := range keys {
			series = append(series, round2(weeks[k].pct))
		}
		result[code] = series
	}
	return result
}

// historyDeltas returns week-on-week deltas for an oldest-first history series.
func historyDeltas(history []float64) []float64 {
	if len(history) < 2 {
		return nil
	}
	deltas := make([]float64, 0, len(history)-1)
	for i := 1; i < len(history); i++ {
		deltas = append(deltas, history[i]-history[i-1])
	}
	return deltas
}

// baselineDeltas returns the weekly deltas to use as the z-score baseline for
// a stock currently at currentPct. When the history extends through the report
// week (its last point is the current value), the final delta IS the change
// being scored — including it would contaminate the baseline mean/std and cap
// every z-score at ~sqrt(n-1) regardless of the move's magnitude, so it is
// dropped.
func baselineDeltas(history []float64, currentPct float64) []float64 {
	deltas := historyDeltas(history)
	if len(deltas) == 0 {
		return deltas
	}
	if history[len(history)-1] == round2(currentPct) {
		return deltas[:len(deltas)-1]
	}
	return deltas
}

// zScoreFor measures how unusual a change is versus the stock's own weekly
// deltas. Returns 0 when fewer than zScoreMinDeltas deltas are available.
func zScoreFor(change float64, deltas []float64) float64 {
	if len(deltas) < zScoreMinDeltas {
		return 0
	}
	var sum float64
	for _, d := range deltas {
		sum += d
	}
	mean := sum / float64(len(deltas))
	var sq float64
	for _, d := range deltas {
		sq += (d - mean) * (d - mean)
	}
	std := math.Sqrt(sq / float64(len(deltas)))
	return round2((change - mean) / math.Max(std, zScoreMinStdDev))
}

// streakWeeks counts consecutive trailing weekly deltas in the same direction
// as the current change (deltas of magnitude >= streakMinDelta count),
// including the current week. deltas are oldest-first; the last delta is the
// current week's move when history extends to the report week.
func streakWeeks(deltas []float64, change float64) int {
	if math.Abs(change) < streakMinDelta {
		return 0
	}
	dir := 1.0
	if change < 0 {
		dir = -1.0
	}
	count := 0
	for i := len(deltas) - 1; i >= 0; i-- {
		d := deltas[i]
		if d*dir > 0 && math.Abs(d) >= streakMinDelta {
			count++
		} else {
			break
		}
	}
	if count == 0 {
		// History missing or didn't capture this week's move — the current
		// week itself still counts as a 1-week streak.
		return 1
	}
	return count
}

// significanceScore combines absolute change, relative change, and statistical
// unusualness into the mover ranking score.
//
//	relative = |change| / max(previousPct, 0.75)
//	score    = |change| * (1.0 + 0.35*min(relative, 2.0) + 0.5*min(|z|/3.0, 1.0))
func significanceScore(change, previousPct, z float64) float64 {
	abs := math.Abs(change)
	relative := abs / math.Max(previousPct, moverRelativeFloor)
	return abs * (1.0 + 0.35*math.Min(relative, 2.0) + 0.5*math.Min(math.Abs(z)/3.0, 1.0))
}

// moverCandidate is a stock eligible for mover ranking.
type moverCandidate struct {
	Code        string
	Name        string
	CurrentPct  float64
	PreviousPct float64
	Change      float64
}

// moverCandidates filters stocks present on both dates with
// |change| >= moverMinChange AND max(current, previous) >= moverMinLevel.
func moverCandidates(current []stockRow, prevMap map[string]float64) []moverCandidate {
	var cands []moverCandidate
	for _, s := range current {
		prev, ok := prevMap[s.Code]
		if !ok {
			continue
		}
		change := s.ShortPct - prev
		if math.Abs(change) < moverMinChange {
			continue
		}
		if math.Max(s.ShortPct, prev) < moverMinLevel {
			continue
		}
		cands = append(cands, moverCandidate{
			Code:        s.Code,
			Name:        s.Name,
			CurrentPct:  s.ShortPct,
			PreviousPct: prev,
			Change:      round2(change),
		})
	}
	return cands
}

// rankMovers scores candidates and returns the top risers and fallers by
// significance. When useZScore is false (monthly/yearly, where a period change
// vs weekly deltas is not meaningful), z is 0 and contributes nothing.
func rankMovers(cands []moverCandidate, histories map[string][]float64, useZScore bool, limit int) (risers, fallers []Mover) {
	var scored []Mover
	for _, c := range cands {
		deltas := historyDeltas(histories[c.Code])
		var z float64
		if useZScore {
			// Baseline excludes the current week's own delta — see baselineDeltas.
			z = zScoreFor(c.Change, baselineDeltas(histories[c.Code], c.CurrentPct))
		}
		scored = append(scored, Mover{
			Code:         c.Code,
			Name:         c.Name,
			CurrentPct:   c.CurrentPct,
			PreviousPct:  c.PreviousPct,
			Change:       c.Change,
			ZScore:       z,
			StreakWeeks:  streakWeeks(deltas, c.Change),
			History:      histories[c.Code],
			Significance: round2(significanceScore(c.Change, c.PreviousPct, z)),
		})
	}

	sort.Slice(scored, func(i, j int) bool {
		if scored[i].Significance != scored[j].Significance {
			return scored[i].Significance > scored[j].Significance
		}
		return scored[i].Code < scored[j].Code // deterministic tie-break
	})

	for _, m := range scored {
		if m.Change > 0 && len(risers) < limit {
			risers = append(risers, m)
		} else if m.Change < 0 && len(fallers) < limit {
			fallers = append(fallers, m)
		}
	}
	return risers, fallers
}

// prevTopCodes returns the codes of the previous period's top-N shorted stocks.
// previous must be sorted by short % descending (as returned by getStocksForDate).
func prevTopCodes(previous []stockRow, n int) map[string]bool {
	set := make(map[string]bool, n)
	for i, s := range previous {
		if i >= n {
			break
		}
		set[s.Code] = true
	}
	return set
}

// buildTopStocks builds the top-N list with period-on-period changes and
// new-entrant detection (top-10 codes not in the previous top-10).
func buildTopStocks(current, previous []stockRow) []TopStock {
	prevMap := make(map[string]float64, len(previous))
	for _, s := range previous {
		prevMap[s.Code] = s.ShortPct
	}
	prevTop := prevTopCodes(previous, topListSize)

	var top []TopStock
	for i, s := range current {
		if i >= topListSize {
			break
		}
		var change float64
		if prev, ok := prevMap[s.Code]; ok {
			change = s.ShortPct - prev
		}
		top = append(top, TopStock{
			Rank:         i + 1,
			Code:         s.Code,
			Name:         s.Name,
			ShortPct:     s.ShortPct,
			WoWChange:    round2(change),
			IsNewEntrant: !prevTop[s.Code],
		})
	}
	return top
}

// daysToCover computes short shares / average daily volume, rounded to 1dp.
// Returns 0 when either input is unknown or non-positive.
func daysToCover(shortShares, avgDailyVolume float64) float64 {
	if shortShares <= 0 || avgDailyVolume <= 0 {
		return 0
	}
	return round1(shortShares / avgDailyVolume)
}

// calculateStats computes aggregate market statistics for the period.
func calculateStats(current, previous []stockRow) MarketStats {
	stats := MarketStats{
		TotalStocksShorted: len(current),
	}

	if len(current) == 0 {
		return stats
	}

	var totalPct float64
	pcts := make([]float64, 0, len(current))
	for _, s := range current {
		totalPct += s.ShortPct
		pcts = append(pcts, s.ShortPct)
		if s.ShortPct > stats.MaxShortPct {
			stats.MaxShortPct = s.ShortPct
			stats.MaxShortCode = s.Code
		}
		if s.ShortPct >= 10 {
			stats.StocksAbove10Pct++
		}
		if s.ShortPct >= 5 {
			stats.StocksAbove5Pct++
		}
	}
	stats.AvgShortPct = round2(totalPct / float64(len(current)))

	// Median short %
	sort.Float64s(pcts)
	mid := len(pcts) / 2
	if len(pcts)%2 == 0 {
		stats.MedianShortPct = round2((pcts[mid-1] + pcts[mid]) / 2)
	} else {
		stats.MedianShortPct = round2(pcts[mid])
	}

	// Previous average for period-on-period comparison, plus market-wide
	// riser/faller counts for stocks present on both dates.
	if len(previous) > 0 {
		var prevTotalPct float64
		prevMap := make(map[string]float64, len(previous))
		for _, s := range previous {
			prevTotalPct += s.ShortPct
			prevMap[s.Code] = s.ShortPct
		}
		prevAvg := prevTotalPct / float64(len(previous))
		stats.WoWAvgChange = round2(stats.AvgShortPct - prevAvg)

		for _, s := range current {
			prev, ok := prevMap[s.Code]
			if !ok {
				continue
			}
			change := s.ShortPct - prev
			if change > marketMoveThreshold {
				stats.RiserCount++
			} else if change < -marketMoveThreshold {
				stats.FallerCount++
			}
		}
	}

	return stats
}

// computeIndustryBreakdown aggregates short interest per industry (industries
// with >= industryMinStocks shorted stocks), comparing against the same
// industry aggregate at the previous date. Sorted by avg short % descending,
// capped at industryMaxRows.
func computeIndustryBreakdown(current, previous []stockRow, industryByCode map[string]string) []IndustryStat {
	if len(industryByCode) == 0 {
		return nil
	}

	type agg struct {
		sum     float64
		count   int
		topCode string
		topPct  float64
	}

	aggregate := func(stocks []stockRow) map[string]*agg {
		out := make(map[string]*agg)
		for _, s := range stocks {
			industry, ok := industryByCode[s.Code]
			if !ok || industry == "" {
				continue
			}
			a := out[industry]
			if a == nil {
				a = &agg{}
				out[industry] = a
			}
			a.sum += s.ShortPct
			a.count++
			if s.ShortPct > a.topPct {
				a.topPct = s.ShortPct
				a.topCode = s.Code
			}
		}
		return out
	}

	cur := aggregate(current)
	prev := aggregate(previous)

	var stats []IndustryStat
	for industry, a := range cur {
		if a.count < industryMinStocks {
			continue
		}
		avg := a.sum / float64(a.count)
		var wow float64
		if p, ok := prev[industry]; ok && p.count > 0 {
			wow = avg - p.sum/float64(p.count)
		}
		stats = append(stats, IndustryStat{
			Industry:     industry,
			AvgShortPct:  round2(avg),
			WoWChange:    round2(wow),
			StockCount:   a.count,
			TopStockCode: a.topCode,
			TopStockPct:  round2(a.topPct),
		})
	}

	sort.Slice(stats, func(i, j int) bool {
		if stats[i].AvgShortPct != stats[j].AvgShortPct {
			return stats[i].AvgShortPct > stats[j].AvgShortPct
		}
		return stats[i].Industry < stats[j].Industry // deterministic tie-break
	})
	if len(stats) > industryMaxRows {
		stats = stats[:industryMaxRows]
	}
	return stats
}

// snapshotOpts controls period-specific behaviour of buildSnapshot.
type snapshotOpts struct {
	// MoverLimit is the max risers/fallers to keep (6 weekly/monthly, 10 yearly).
	MoverLimit int
	// UseZScore enables the z-score term; only meaningful when the period
	// change is itself a weekly delta (weekly reports).
	UseZScore bool
}

// snapshotResult holds the computed snapshot artifacts for a period.
type snapshotResult struct {
	TopShorted        []TopStock
	Risers            []Mover
	Fallers           []Mover
	Stats             MarketStats
	IndustryBreakdown []IndustryStat
}

// buildSnapshot computes the top list, movers v2, market stats, and industry
// breakdown for a period comparison, enriching mentioned stocks with weekly
// history, days-to-cover, and industry. Enrichment failures are logged and
// skipped (WARNING-log-and-continue) — the core snapshot always succeeds.
func (c *DataCollector) buildSnapshot(ctx context.Context, reportDate string, current, previous []stockRow, opts snapshotOpts) snapshotResult {
	prevMap := make(map[string]float64, len(previous))
	for _, s := range previous {
		prevMap[s.Code] = s.ShortPct
	}

	top := buildTopStocks(current, previous)
	cands := moverCandidates(current, prevMap)

	// One history query covers the top list and every mover candidate — the
	// z-scores need candidate history BEFORE ranking.
	histCodes := make(map[string]bool, len(top)+len(cands))
	for _, s := range top {
		histCodes[s.Code] = true
	}
	for _, cand := range cands {
		histCodes[cand.Code] = true
	}
	histories := c.getShortHistory(ctx, setToSlice(histCodes), reportDate)

	risers, fallers := rankMovers(cands, histories, opts.UseZScore, opts.MoverLimit)

	for i := range top {
		top[i].History = histories[top[i].Code]
	}

	// Days-to-cover for every mentioned stock: short shares at report date /
	// 20-day average daily volume.
	mentioned := collectMentionedCodes(top, risers, fallers)
	avgVolumes := c.getAvgDailyVolumes(ctx, mentioned, reportDate)
	sharesByCode := make(map[string]float64, len(current))
	for _, s := range current {
		sharesByCode[s.Code] = s.ShortShares
	}
	for i := range top {
		top[i].DaysToCover = daysToCover(sharesByCode[top[i].Code], avgVolumes[top[i].Code])
	}
	for i := range risers {
		risers[i].DaysToCover = daysToCover(sharesByCode[risers[i].Code], avgVolumes[risers[i].Code])
	}
	for i := range fallers {
		fallers[i].DaysToCover = daysToCover(sharesByCode[fallers[i].Code], avgVolumes[fallers[i].Code])
	}

	// Industry for ALL stocks on both dates — feeds the per-industry
	// aggregates and the per-stock industry field.
	allCodes := make(map[string]bool, len(current)+len(previous))
	for _, s := range current {
		allCodes[s.Code] = true
	}
	for _, s := range previous {
		allCodes[s.Code] = true
	}
	industryByCode := c.getIndustryMap(ctx, setToSlice(allCodes))

	breakdown := computeIndustryBreakdown(current, previous, industryByCode)
	for i := range top {
		top[i].Industry = industryByCode[top[i].Code]
	}
	for i := range risers {
		risers[i].Industry = industryByCode[risers[i].Code]
	}
	for i := range fallers {
		fallers[i].Industry = industryByCode[fallers[i].Code]
	}

	return snapshotResult{
		TopShorted:        top,
		Risers:            risers,
		Fallers:           fallers,
		Stats:             calculateStats(current, previous),
		IndustryBreakdown: breakdown,
	}
}

func setToSlice(set map[string]bool) []string {
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
