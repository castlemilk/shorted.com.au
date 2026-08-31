package shorts

import "testing"

func TestLiquidityBand(t *testing.T) {
	tests := []struct {
		name  string
		value float64
		want  string
	}{
		{"BHP-scale turnover", 578_000_000, "mega"},
		{"exactly at the mega floor", 100_000_000, "mega"},
		{"just below the mega floor", 99_999_999, "large"},
		{"large", 50_000_000, "large"},
		{"exactly at the large floor", 10_000_000, "large"},
		{"mid", 5_000_000, "mid"},
		{"exactly at the mid floor", 1_000_000, "mid"},
		{"small", 500_000, "small"},
		{"exactly at the small floor", 100_000, "small"},
		{"micro", 12_345, "micro"},

		// Unknown is NOT micro. A caller filtering out micro-caps is saying
		// "too illiquid to trade"; applying that to a stock we simply have no
		// prices for would silently drop it on a fact we do not have. An empty
		// band is a question, not an answer.
		{"unknown reads as unknown, never micro", 0, ""},
		{"a negative value is unusable, not micro", -1, ""},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := liquidityBand(tc.value); got != tc.want {
				t.Errorf("liquidityBand(%v) = %q, want %q", tc.value, got, tc.want)
			}
		})
	}
}

// The bands must be ordered and exhaustive: every positive value lands in
// exactly one, and a larger value never lands in a smaller band.
func TestLiquidityBandsAreMonotonic(t *testing.T) {
	rank := map[string]int{"micro": 0, "small": 1, "mid": 2, "large": 3, "mega": 4}
	prev := -1
	for _, v := range []float64{1, 99_999, 100_000, 999_999, 1_000_000, 9_999_999,
		10_000_000, 99_999_999, 100_000_000, 1_000_000_000} {
		band := liquidityBand(v)
		r, ok := rank[band]
		if !ok {
			t.Fatalf("liquidityBand(%v) = %q, which is not a known band", v, band)
		}
		if r < prev {
			t.Errorf("liquidityBand(%v) = %q went backwards", v, band)
		}
		prev = r
	}
}
