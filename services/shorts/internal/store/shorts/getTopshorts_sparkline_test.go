package shorts

import (
	"strings"
	"testing"

	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
)

// referenceDecimatePoints is the Go decimation FetchTimeSeriesData ran over the
// full daily series until sparklineQuery took it over (decimatePoints,
// 2026-10), kept verbatim as the reference the SQL must reproduce: at most
// maxPoints points, evenly spaced, always the first and the last.
func referenceDecimatePoints(points []*stocksv1alpha1.TimeSeriesPoint, maxPoints int) []*stocksv1alpha1.TimeSeriesPoint {
	if maxPoints <= 1 || len(points) <= maxPoints {
		return points
	}
	out := make([]*stocksv1alpha1.TimeSeriesPoint, 0, maxPoints)
	step := float64(len(points)-1) / float64(maxPoints-1)
	for i := 0; i < maxPoints-1; i++ {
		out = append(out, points[int(float64(i)*step)])
	}
	out = append(out, points[len(points)-1]) // always include the most recent point
	return out
}

// referenceKeptIndexes is the index set referenceDecimatePoints keeps.
func referenceKeptIndexes(n, maxPoints int) map[int]bool {
	points := make([]*stocksv1alpha1.TimeSeriesPoint, n)
	index := make(map[*stocksv1alpha1.TimeSeriesPoint]int, n)
	for i := range points {
		points[i] = &stocksv1alpha1.TimeSeriesPoint{}
		index[points[i]] = i
	}
	kept := map[int]bool{}
	for _, p := range referenceDecimatePoints(points, maxPoints) {
		kept[index[p]] = true
	}
	return kept
}

// sparklineKeeps is the SQL's is_point test; it must keep exactly the indexes
// the old Go decimation kept, for every series length, including the lengths
// where rn / step rounds across an integer.
func TestSparklineKeeps_MatchesTheOldDecimationForEverySeriesLength(t *testing.T) {
	lengths := []int{}
	for n := 1; n <= 3000; n++ {
		lengths = append(lengths, n)
	}
	for n := 3001; n <= 20000; n += 97 {
		lengths = append(lengths, n)
	}
	for _, maxPoints := range []int{topShortsSparklineMaxPoints, 2, 61} {
		for _, n := range lengths {
			want := referenceKeptIndexes(n, maxPoints)
			got := 0
			for rn := range n {
				keeps := sparklineKeeps(rn, n, maxPoints)
				if keeps != want[rn] {
					t.Fatalf("maxPoints=%d n=%d rn=%d: sparklineKeeps=%v, the old decimation kept=%v", maxPoints, n, rn, keeps, want[rn])
				}
				if keeps {
					got++
				}
			}
			if got != len(want) {
				t.Fatalf("maxPoints=%d n=%d: kept %d points, the old decimation kept %d", maxPoints, n, got, len(want))
			}
		}
	}
}

// The SQL and its Go twin must test the same three candidates.
func TestSparklineQuery_TestsTheSameCandidatesAsSparklineKeeps(t *testing.T) {
	for _, want := range []string{
		"CASE WHEN n > $2::int THEN (n - 1)::float8 / ($2::int - 1)::float8 END AS step",
		"ceil(rn::float8 / step)::int END AS c",
		"(c - 1 BETWEEN 0 AND $2::int - 2 AND floor((c - 1)::float8 * step) = rn)",
		"(c     BETWEEN 0 AND $2::int - 2 AND floor(c::float8 * step) = rn)",
		"(c + 1 BETWEEN 0 AND $2::int - 2 AND floor((c + 1)::float8 * step) = rn)",
		"n <= $2::int OR rn = n - 1",
		// Index order, so no sort before the windows.
		`row_number() OVER (w ORDER BY "DATE" DESC) AS back`,
		"min(date) FILTER (WHERE pct = lo) OVER (PARTITION BY code) AS lo_date",
		"min(date) FILTER (WHERE pct = hi) OVER (PARTITION BY code) AS hi_date",
		"WHERE is_point OR date = lo_date OR date = hi_date",
	} {
		if !strings.Contains(sparklineQuery, want) {
			t.Errorf("sparklineQuery missing %q", want)
		}
	}
}
