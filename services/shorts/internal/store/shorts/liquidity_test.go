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

func TestDaysToCover(t *testing.T) {
	tests := []struct {
		name   string
		short  float64
		volume float64
		want   float64
	}{
		// 5% short of a register that turns over quickly: a short unwind of
		// days, not weeks.
		{"liquid name", 2_500_000, 1_000_000, 2.5},
		// The same percent against a thin tape is where squeezes come from.
		{"illiquid name", 5_000_000, 100_000, 50},
		{"exactly one session", 1_000_000, 1_000_000, 1},

		// Not computable is 0, never infinity and never a huge number. A name
		// with no recent volume is precisely the illiquid case where a giant
		// days-to-cover looks most dramatic and means least — it would sort to
		// the top of a squeeze screen on the strength of missing data.
		{"no volume data", 5_000_000, 0, 0},
		{"negative volume", 5_000_000, -1, 0},
		{"no short position", 0, 1_000_000, 0},
		{"negative short position", -5, 1_000_000, 0},
		{"neither known", 0, 0, 0},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := daysToCover(tc.short, tc.volume)
			if got != tc.want {
				t.Errorf("daysToCover(%v, %v) = %v, want %v", tc.short, tc.volume, got, tc.want)
			}
		})
	}
}

// Two names with the SAME percent of issue short must be separable by
// days-to-cover — that separation is the entire reason the metric exists.
func TestDaysToCoverSeparatesEqualPercentages(t *testing.T) {
	const sharesOnIssue = 100_000_000
	const shortPositions = sharesOnIssue * 0.05 // 5% short in both cases

	liquid := daysToCover(shortPositions, sharesOnIssue*0.02)    // 2% daily turnover
	illiquid := daysToCover(shortPositions, sharesOnIssue*0.001) // 0.1% daily turnover

	if liquid >= illiquid {
		t.Fatalf("liquid %v should cover far faster than illiquid %v", liquid, illiquid)
	}
	if illiquid/liquid < 10 {
		t.Errorf("a 20x turnover difference should show as a large days-to-cover gap, got %vx", illiquid/liquid)
	}
}

// The metric must never be computed against traded VALUE. Dividing a share
// count by dollars yields a number with no meaning, and it would look
// plausible — small, positive, and completely wrong.
func TestDaysToCoverUsesVolumeNotValue(t *testing.T) {
	const shortPositions = 5_000_000
	const volumeShares = 1_000_000
	const priceDollars = 40.0

	correct := daysToCover(shortPositions, volumeShares)
	ifValueWereUsed := daysToCover(shortPositions, volumeShares*priceDollars)

	if correct != 5 {
		t.Fatalf("expected 5 sessions, got %v", correct)
	}
	if ifValueWereUsed == correct {
		t.Fatal("value and volume produced the same answer; this test cannot detect the mistake")
	}
}
