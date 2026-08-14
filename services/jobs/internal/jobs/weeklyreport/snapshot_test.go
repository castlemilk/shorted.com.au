package weeklyreport

import (
	"math"
	"testing"
	"time"
)

func d(t *testing.T, s string) time.Time {
	t.Helper()
	parsed, err := time.Parse("2006-01-02", s)
	if err != nil {
		t.Fatalf("bad date %s: %v", s, err)
	}
	return parsed
}

func TestBucketWeeklyHistory(t *testing.T) {
	t.Parallel()
	report := "2026-03-06" // Friday, same ISO week as 2026-03-02

	points := []historyPoint{
		// Week of Feb 16-20: two observations — the later one (Feb 19) wins
		{Code: "AAA", Date: d(t, "2026-02-17"), Pct: 1.004},
		{Code: "AAA", Date: d(t, "2026-02-19"), Pct: 1.101},
		// Week of Feb 23-27
		{Code: "AAA", Date: d(t, "2026-02-25"), Pct: 1.2},
		// Report week: Mar 5 beats Mar 4
		{Code: "AAA", Date: d(t, "2026-03-04"), Pct: 1.3},
		{Code: "AAA", Date: d(t, "2026-03-05"), Pct: 1.349},
		// After the report week — must be excluded
		{Code: "AAA", Date: d(t, "2026-03-11"), Pct: 9.9},
		// Second code, single point
		{Code: "BBB", Date: d(t, "2026-03-02"), Pct: 4.0},
	}

	got := bucketWeeklyHistory(points, d(t, report), maxHistoryPoints)

	wantAAA := []float64{1.1, 1.2, 1.35} // rounded 2dp
	if len(got["AAA"]) != len(wantAAA) {
		t.Fatalf("AAA history = %v, want %v", got["AAA"], wantAAA)
	}
	for i, v := range wantAAA {
		if got["AAA"][i] != v {
			t.Errorf("AAA history[%d] = %v, want %v", i, got["AAA"][i], v)
		}
	}
	if len(got["BBB"]) != 1 || got["BBB"][0] != 4.0 {
		t.Errorf("BBB history = %v, want [4]", got["BBB"])
	}
}

func TestBucketWeeklyHistoryCapsAtMaxPoints(t *testing.T) {
	t.Parallel()
	report := d(t, "2026-06-26")
	var points []historyPoint
	// 20 consecutive weekly observations ending at the report week
	for i := 19; i >= 0; i-- {
		points = append(points, historyPoint{
			Code: "AAA",
			Date: report.AddDate(0, 0, -7*i),
			Pct:  float64(100 - i), // oldest = 81, newest = 100
		})
	}
	got := bucketWeeklyHistory(points, report, maxHistoryPoints)
	series := got["AAA"]
	if len(series) != maxHistoryPoints {
		t.Fatalf("history length = %d, want %d", len(series), maxHistoryPoints)
	}
	if series[0] != 88 || series[len(series)-1] != 100 {
		t.Errorf("history = %v, want last 13 points 88..100", series)
	}
}

func TestHistoryDeltas(t *testing.T) {
	t.Parallel()
	if got := historyDeltas(nil); got != nil {
		t.Errorf("nil history deltas = %v, want nil", got)
	}
	if got := historyDeltas([]float64{5}); got != nil {
		t.Errorf("single-point deltas = %v, want nil", got)
	}
	got := historyDeltas([]float64{1.0, 1.5, 1.2})
	want := []float64{0.5, -0.3}
	if len(got) != 2 || math.Abs(got[0]-want[0]) > 1e-9 || math.Abs(got[1]-want[1]) > 1e-9 {
		t.Errorf("deltas = %v, want %v", got, want)
	}
}

func TestBaselineDeltas(t *testing.T) {
	t.Parallel()
	// History extends through the report week (last point == current pct):
	// the final delta is the change being scored and must be dropped.
	history := []float64{2.0, 2.0, 2.0, 2.0, 7.0}
	got := baselineDeltas(history, 7.0)
	want := []float64{0, 0, 0}
	if len(got) != len(want) {
		t.Fatalf("baseline deltas = %v, want %v", got, want)
	}
	for i, v := range want {
		if math.Abs(got[i]-v) > 1e-9 {
			t.Errorf("baseline deltas[%d] = %v, want %v", i, got[i], v)
		}
	}

	// History NOT extending to the report week: all deltas are baseline.
	got = baselineDeltas([]float64{2.0, 2.5, 3.0}, 7.0)
	if len(got) != 2 {
		t.Errorf("stale-history baseline deltas = %v, want 2 deltas", got)
	}

	// Degenerate histories.
	if got := baselineDeltas(nil, 1.0); got != nil {
		t.Errorf("nil history baseline = %v, want nil", got)
	}
	if got := baselineDeltas([]float64{5.0}, 5.0); got != nil {
		t.Errorf("single-point baseline = %v, want nil", got)
	}
}

func TestRankMoversZScoreExcludesCurrentWeekFromBaseline(t *testing.T) {
	t.Parallel()
	// A stock flat at 2.00 for 13 weeks that jumps +5.0pp in the report week.
	// The history (as built by bucketWeeklyHistory) extends THROUGH the report
	// week, so its last delta is the +5.0 move itself. The baseline must
	// exclude it: 12 flat deltas → mean 0, std floored at 0.15 →
	// z = 5.0/0.15 = 33.33. With the contaminated baseline this would have
	// been capped near sqrt(n-1) ≈ 3.5.
	history := make([]float64, 0, 14)
	for i := 0; i < 13; i++ {
		history = append(history, 2.0)
	}
	history = append(history, 7.0)

	cands := []moverCandidate{
		{Code: "JMP", Name: "Jumper", CurrentPct: 7.0, PreviousPct: 2.0, Change: 5.0},
	}
	risers, _ := rankMovers(cands, map[string][]float64{"JMP": history}, true, 6)
	if len(risers) != 1 {
		t.Fatalf("risers = %d, want 1", len(risers))
	}
	if got := risers[0].ZScore; math.Abs(got-33.33) > 1e-9 {
		t.Errorf("z-score = %v, want 33.33 (baseline must exclude the current week's delta)", got)
	}
}

func TestZScoreFor(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		change float64
		deltas []float64
		want   float64
	}{
		{
			name:   "fewer than 6 deltas returns 0",
			change: 2.0,
			deltas: []float64{0.1, 0.2, 0.1, 0.2, 0.1},
			want:   0,
		},
		{
			name:   "stddev floored at 0.15",
			change: 1.0,
			// mean 0, stddev 0.1 → floored to 0.15 → z = 1.0/0.15 = 6.67
			deltas: []float64{0.1, -0.1, 0.1, -0.1, 0.1, -0.1},
			want:   6.67,
		},
		{
			name:   "typical move within norm",
			change: 0.1,
			// mean 0.1, stddev floored → z = 0
			deltas: []float64{0.1, 0.1, 0.1, 0.1, 0.1, 0.1},
			want:   0,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := zScoreFor(tt.change, tt.deltas); math.Abs(got-tt.want) > 1e-9 {
				t.Errorf("zScoreFor(%v, %v) = %v, want %v", tt.change, tt.deltas, got, tt.want)
			}
		})
	}
}

func TestStreakWeeks(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		deltas []float64
		change float64
		want   int
	}{
		{"three consecutive rises", []float64{0.2, 0.3, 0.15}, 0.15, 3},
		{"streak broken by opposite move", []float64{-0.2, 0.3, 0.15}, 0.15, 2},
		{"streak broken by tiny move", []float64{0.2, 0.04, 0.15}, 0.15, 1},
		{"falling streak", []float64{-0.1, -0.2, -0.3}, -0.3, 3},
		{"no history still counts current week", nil, 0.5, 1},
		{"direction mismatch counts current week only", []float64{0.3, 0.4}, -0.2, 1},
		{"sub-threshold change has no streak", []float64{0.2, 0.3}, 0.02, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := streakWeeks(tt.deltas, tt.change); got != tt.want {
				t.Errorf("streakWeeks(%v, %v) = %d, want %d", tt.deltas, tt.change, got, tt.want)
			}
		})
	}
}

func TestSignificanceScore(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name            string
		change, prev, z float64
		want            float64
	}{
		{"small relative, no z", 1.0, 10.0, 0, 1.0 * (1 + 0.35*0.1)},
		{"relative capped at 2", 3.0, 0.5, 0, 3.0 * (1 + 0.35*2.0)},
		{"low base floored at 0.75", 1.0, 0.1, 0, 1.0 * (1 + 0.35*(1.0/0.75))},
		{"z term", 1.0, 10.0, 3.0, 1.0 * (1 + 0.35*0.1 + 0.5*1.0)},
		{"z term capped", 1.0, 10.0, 9.0, 1.0 * (1 + 0.35*0.1 + 0.5*1.0)},
		{"negative change uses absolute", -1.0, 10.0, 0, 1.0 * (1 + 0.35*0.1)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := significanceScore(tt.change, tt.prev, tt.z)
			if math.Abs(got-tt.want) > 1e-9 {
				t.Errorf("significanceScore(%v, %v, %v) = %v, want %v", tt.change, tt.prev, tt.z, got, tt.want)
			}
		})
	}
}

func TestMoverCandidates(t *testing.T) {
	t.Parallel()
	current := []stockRow{
		{Code: "AAA", Name: "Alpha", ShortPct: 5.0}, // change +1.0 → candidate
		{Code: "BBB", Name: "Beta", ShortPct: 0.4},  // level too low
		{Code: "CCC", Name: "Gamma", ShortPct: 5.0}, // change too small
		{Code: "DDD", Name: "Delta", ShortPct: 2.0}, // not in previous
		{Code: "EEE", Name: "Echo", ShortPct: 0.6},  // just above both gates
		{Code: "FFF", Name: "Fox", ShortPct: 1.0},   // change -1.5 → candidate (faller)
	}
	prevMap := map[string]float64{
		"AAA": 4.0,
		"BBB": 0.3,
		"CCC": 4.95,
		"EEE": 0.45,
		"FFF": 2.5,
	}

	cands := moverCandidates(current, prevMap)
	got := make(map[string]moverCandidate)
	for _, c := range cands {
		got[c.Code] = c
	}
	if len(cands) != 3 {
		t.Fatalf("candidates = %v, want AAA, EEE, FFF", got)
	}
	for _, code := range []string{"AAA", "EEE", "FFF"} {
		if _, ok := got[code]; !ok {
			t.Errorf("expected candidate %s", code)
		}
	}
	if got["AAA"].Change != 1.0 {
		t.Errorf("AAA change = %v, want 1.0", got["AAA"].Change)
	}
	if got["FFF"].Change != -1.5 {
		t.Errorf("FFF change = %v, want -1.5", got["FFF"].Change)
	}
}

func TestRankMoversOrdersBySignificance(t *testing.T) {
	t.Parallel()
	// Y has a smaller absolute change than X but a much larger relative change,
	// so significance ranks Y above X.
	cands := []moverCandidate{
		{Code: "XXX", Name: "Big base", CurrentPct: 11.0, PreviousPct: 10.0, Change: 1.0},
		{Code: "YYY", Name: "Small base", CurrentPct: 1.8, PreviousPct: 0.9, Change: 0.9},
		{Code: "ZZZ", Name: "Faller", CurrentPct: 1.0, PreviousPct: 2.5, Change: -1.5},
	}
	risers, fallers := rankMovers(cands, nil, true, 6)

	if len(risers) != 2 {
		t.Fatalf("risers = %d, want 2", len(risers))
	}
	if risers[0].Code != "YYY" {
		t.Errorf("top riser = %s, want YYY (significance beats absolute change)", risers[0].Code)
	}
	if len(fallers) != 1 || fallers[0].Code != "ZZZ" {
		t.Fatalf("fallers = %v, want [ZZZ]", fallers)
	}
	if fallers[0].Significance <= 0 {
		t.Errorf("faller significance = %v, want > 0", fallers[0].Significance)
	}
	// Without history, streak falls back to the current week
	if risers[0].StreakWeeks != 1 {
		t.Errorf("streak = %d, want 1", risers[0].StreakWeeks)
	}
}

func TestRankMoversLimitsAndZScore(t *testing.T) {
	t.Parallel()
	var cands []moverCandidate
	for i := 0; i < 8; i++ {
		cands = append(cands, moverCandidate{
			Code:        string(rune('A'+i)) + "AA",
			CurrentPct:  5.0 + float64(i),
			PreviousPct: 4.0,
			Change:      1.0 + float64(i)*0.1,
		})
	}
	histories := map[string][]float64{
		// 7 points → 6 deltas alternating ±0.1: mean 0, stddev 0.1 → floored 0.15
		"AAA": {4.0, 4.1, 4.0, 4.1, 4.0, 4.1, 4.0},
	}
	risers, fallers := rankMovers(cands, histories, true, 6)
	if len(risers) != 6 {
		t.Errorf("risers = %d, want capped at 6", len(risers))
	}
	if len(fallers) != 0 {
		t.Errorf("fallers = %d, want 0", len(fallers))
	}
	var aaa *Mover
	for i := range risers {
		if risers[i].Code == "AAA" {
			aaa = &risers[i]
		}
	}
	if aaa == nil {
		t.Fatal("AAA not in risers")
	}
	if aaa.ZScore != 6.67 { // 1.0 / 0.15 rounded 2dp
		t.Errorf("AAA z-score = %v, want 6.67", aaa.ZScore)
	}

	// With z disabled (monthly/yearly), z must be 0
	risersNoZ, _ := rankMovers(cands, histories, false, 6)
	for _, m := range risersNoZ {
		if m.ZScore != 0 {
			t.Errorf("z-score with useZScore=false = %v, want 0", m.ZScore)
		}
	}
}

func TestBuildTopStocksNewEntrants(t *testing.T) {
	t.Parallel()
	var current, previous []stockRow
	for i := 0; i < 12; i++ {
		code := string(rune('A'+i)) + "AA"
		current = append(current, stockRow{Code: code, Name: code, ShortPct: 20.0 - float64(i)})
	}
	// Previous top 10 = same codes except LAA (rank 12 current, absent) and
	// KAA; previous includes NEW at rank 1 pushing others down. Make CAA
	// absent from previous top-10 by placing it at rank 11.
	previous = []stockRow{
		{Code: "NEW", ShortPct: 30},
		{Code: "AAA", ShortPct: 19},
		{Code: "BAA", ShortPct: 18},
		{Code: "DAA", ShortPct: 17},
		{Code: "EAA", ShortPct: 16},
		{Code: "FAA", ShortPct: 15},
		{Code: "GAA", ShortPct: 14},
		{Code: "HAA", ShortPct: 13},
		{Code: "IAA", ShortPct: 12},
		{Code: "JAA", ShortPct: 11},
		{Code: "CAA", ShortPct: 10.5}, // rank 11 previously → new entrant now
	}

	top := buildTopStocks(current, previous)
	if len(top) != 10 {
		t.Fatalf("top = %d, want 10", len(top))
	}
	byCode := make(map[string]TopStock)
	for _, s := range top {
		byCode[s.Code] = s
	}
	if !byCode["CAA"].IsNewEntrant {
		t.Error("CAA was rank 11 previously — should be a new entrant")
	}
	if byCode["AAA"].IsNewEntrant {
		t.Error("AAA was in the previous top 10 — should not be a new entrant")
	}
	// WoW change: CAA 18.0 now vs 10.5 previously
	if byCode["CAA"].WoWChange != 7.5 {
		t.Errorf("CAA WoW change = %v, want 7.5", byCode["CAA"].WoWChange)
	}
	if byCode["AAA"].Rank != 1 {
		t.Errorf("AAA rank = %d, want 1", byCode["AAA"].Rank)
	}
}

func TestDaysToCover(t *testing.T) {
	t.Parallel()
	tests := []struct {
		shares, vol, want float64
	}{
		{1_000_000, 200_000, 5.0},
		{1_234_567, 200_000, 6.2},
		{0, 200_000, 0},
		{1_000_000, 0, 0},
		{-5, 100, 0},
	}
	for _, tt := range tests {
		if got := daysToCover(tt.shares, tt.vol); got != tt.want {
			t.Errorf("daysToCover(%v, %v) = %v, want %v", tt.shares, tt.vol, got, tt.want)
		}
	}
}

func TestCalculateStatsExtras(t *testing.T) {
	t.Parallel()
	current := []stockRow{
		{Code: "AAA", ShortPct: 15.0},
		{Code: "BBB", ShortPct: 11.0},
		{Code: "CCC", ShortPct: 7.0},
		{Code: "DDD", ShortPct: 3.0},
		{Code: "EEE", ShortPct: 1.0},
	}
	previous := []stockRow{
		{Code: "AAA", ShortPct: 14.0},   // riser (+1.0)
		{Code: "BBB", ShortPct: 11.005}, // within threshold → neither
		{Code: "CCC", ShortPct: 7.5},    // faller (-0.5)
		{Code: "DDD", ShortPct: 3.5},    // faller (-0.5)
		// EEE not present previously
	}

	stats := calculateStats(current, previous)

	if stats.TotalStocksShorted != 5 {
		t.Errorf("total = %d, want 5", stats.TotalStocksShorted)
	}
	if stats.MedianShortPct != 7.0 {
		t.Errorf("median = %v, want 7.0", stats.MedianShortPct)
	}
	if stats.StocksAbove10Pct != 2 {
		t.Errorf("above 10%% = %d, want 2", stats.StocksAbove10Pct)
	}
	if stats.StocksAbove5Pct != 3 {
		t.Errorf("above 5%% = %d, want 3", stats.StocksAbove5Pct)
	}
	if stats.RiserCount != 1 {
		t.Errorf("riser count = %d, want 1", stats.RiserCount)
	}
	if stats.FallerCount != 2 {
		t.Errorf("faller count = %d, want 2", stats.FallerCount)
	}
	if stats.MaxShortCode != "AAA" || stats.MaxShortPct != 15.0 {
		t.Errorf("max = %s %v, want AAA 15.0", stats.MaxShortCode, stats.MaxShortPct)
	}

	// Even-length median
	evenStats := calculateStats(current[:4], nil)
	if evenStats.MedianShortPct != 9.0 { // (7+11)/2
		t.Errorf("even median = %v, want 9.0", evenStats.MedianShortPct)
	}
}

func TestComputeIndustryBreakdown(t *testing.T) {
	t.Parallel()
	industry := map[string]string{
		"AAA": "Metals & Mining", "BBB": "Metals & Mining", "CCC": "Metals & Mining",
		"DDD": "Software", "EEE": "Software", // only 2 stocks → excluded
		"FFF": "Energy", "GGG": "Energy", "HHH": "Energy", "III": "Energy",
	}
	current := []stockRow{
		{Code: "AAA", ShortPct: 9.0},
		{Code: "BBB", ShortPct: 6.0},
		{Code: "CCC", ShortPct: 3.0}, // Metals avg 6.0, top AAA 9.0
		{Code: "DDD", ShortPct: 12.0},
		{Code: "EEE", ShortPct: 10.0},
		{Code: "FFF", ShortPct: 2.0},
		{Code: "GGG", ShortPct: 4.0},
		{Code: "HHH", ShortPct: 6.0},
		{Code: "III", ShortPct: 8.0},  // Energy avg 5.0, top III 8.0
		{Code: "ZZZ", ShortPct: 20.0}, // no industry mapping → ignored
	}
	previous := []stockRow{
		{Code: "AAA", ShortPct: 8.0},
		{Code: "BBB", ShortPct: 5.0},
		{Code: "CCC", ShortPct: 2.0}, // Metals prev avg 5.0 → wow +1.0
		{Code: "FFF", ShortPct: 5.0},
		{Code: "GGG", ShortPct: 5.0}, // Energy prev avg 5.0 → wow 0.0
	}

	got := computeIndustryBreakdown(current, previous, industry)
	if len(got) != 2 {
		t.Fatalf("breakdown = %+v, want 2 industries (Software excluded: <3 stocks)", got)
	}
	// Sorted by avg desc: Metals (6.0) then Energy (5.0)
	if got[0].Industry != "Metals & Mining" || got[1].Industry != "Energy" {
		t.Fatalf("order = [%s, %s], want [Metals & Mining, Energy]", got[0].Industry, got[1].Industry)
	}
	m := got[0]
	if m.AvgShortPct != 6.0 || m.WoWChange != 1.0 || m.StockCount != 3 || m.TopStockCode != "AAA" || m.TopStockPct != 9.0 {
		t.Errorf("Metals = %+v, want avg 6.0, wow 1.0, count 3, top AAA 9.0", m)
	}
	e := got[1]
	if e.AvgShortPct != 5.0 || e.WoWChange != 0.0 || e.StockCount != 4 || e.TopStockCode != "III" {
		t.Errorf("Energy = %+v, want avg 5.0, wow 0.0, count 4, top III", e)
	}
}

func TestComputeIndustryBreakdownCap(t *testing.T) {
	t.Parallel()
	industryByCode := make(map[string]string)
	var current []stockRow
	for i := 0; i < 15; i++ {
		ind := string(rune('A'+i)) + "-industry"
		for j := 0; j < 3; j++ {
			code := string(rune('A'+i)) + string(rune('A'+j)) + "X"
			industryByCode[code] = ind
			current = append(current, stockRow{Code: code, ShortPct: float64(i) + 1})
		}
	}
	got := computeIndustryBreakdown(current, nil, industryByCode)
	if len(got) != industryMaxRows {
		t.Errorf("breakdown = %d rows, want capped at %d", len(got), industryMaxRows)
	}
	// Highest average first
	if got[0].AvgShortPct < got[len(got)-1].AvgShortPct {
		t.Error("breakdown not sorted by avg short % descending")
	}
}
