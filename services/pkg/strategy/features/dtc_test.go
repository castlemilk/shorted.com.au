package features

import (
	"math"
	"testing"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
)

// TestDTCIncludesZeroVolumeBars: the sf1 average covers the last 20 sessions and
// counts a zero-volume session as zero. Half the window traded at 1,000, so the
// mean is 500 and 5,000 positions cover in 10 days. Skipping the zero bars would
// report 5 days, halving the time to cover.
func TestDTCIncludesZeroVolumeBars(t *testing.T) {
	bars := barsFrom(t, "2026-09-01", 20)
	for i := range bars {
		if i%2 == 0 {
			bars[i].Volume = 0
		}
	}
	got, reason := DaysToCover(bars, bars[len(bars)-1].Date, 5_000)
	if reason != "" {
		t.Fatalf("DaysToCover unknown: %s", reason)
	}
	if math.Abs(got-10) > 1e-9 {
		t.Errorf("DaysToCover = %v, want 10 (zero-volume sessions in the mean)", got)
	}
}

func TestDaysToCoverUnknownBelowTheWindow(t *testing.T) {
	asOf := mustDate(t, "2026-09-30")

	short := barsFrom(t, "2026-09-03", 19)
	if _, reason := DaysToCover(short, short[len(short)-1].Date, 1); reason != ReasonNoVolume {
		t.Errorf("19 bars: reason = %q, want %q", reason, ReasonNoVolume)
	}

	thin := barsFrom(t, "2026-09-01", 20)
	for i := 0; i < 11; i++ {
		thin[i].Volume = 0
	}
	if _, reason := DaysToCover(thin, asOf, 1); reason != ReasonNoVolume {
		t.Errorf("9 traded bars: reason = %q, want %q", reason, ReasonNoVolume)
	}
}

// TestDaysToCoverV0Rounding: sf0 rounds its mean to a whole share count, half
// away from zero, and rounds the result to two places.
func TestDaysToCoverV0Rounding(t *testing.T) {
	asOf := mustDate(t, "2026-09-30")
	bars := barsFrom(t, "2026-09-01", 22)
	// Five traded bars inside the 35-day span: mean 1000.4 rounds to 1000.
	for i := range bars {
		bars[i].Volume = 0
	}
	for i := 17; i < 22; i++ {
		bars[i].Volume = 1000
	}
	bars[21].Volume = 1002 // sum 5002, mean 1000.4
	got, reason := DaysToCoverV0(bars, asOf, 2_500)
	if reason != "" {
		t.Fatalf("unknown: %s", reason)
	}
	if got != 2.5 {
		t.Errorf("DaysToCoverV0 = %v, want 2.5 (mean rounded to 1000)", got)
	}

	// Half away from zero: a mean of exactly 1000.5 becomes 1001.
	bars[21].Volume = 1002.5 // sum 5002.5, mean 1000.5
	got, _ = DaysToCoverV0(bars, asOf, 1001)
	if got != 1 {
		t.Errorf("DaysToCoverV0 = %v, want 1 (mean 1000.5 rounds to 1001)", got)
	}

	// Four traded sessions is below the five-row minimum.
	bars[17].Volume = 0
	if _, reason := DaysToCoverV0(bars, asOf, 2_500); reason != ReasonNoVolume {
		t.Errorf("4 traded rows: reason = %q, want %q", reason, ReasonNoVolume)
	}
}

// TestDaysToCoverV0HalfCentRounding: a quotient at an exact half cent rounds
// up as the database rounds it. 201 over a mean of 200 is 1.005, which is 1.01;
// rounding the binary value gives 1.00. 57 over 200 is 0.285, which is 0.29.
func TestDaysToCoverV0HalfCentRounding(t *testing.T) {
	asOf := mustDate(t, "2026-09-30")
	bars := barsFrom(t, "2026-09-01", 5)
	for i := range bars {
		bars[i].Volume = 200
	}
	tests := []struct {
		positions float64
		want      float64
	}{
		{201, 1.01},
		{57, 0.29},
		{1_005_000, 5_025},
		{0, 0},
	}
	for _, tc := range tests {
		got, reason := DaysToCoverV0(bars, asOf, tc.positions)
		if reason != "" {
			t.Fatalf("positions %v: unknown: %s", tc.positions, reason)
		}
		if got != tc.want {
			t.Errorf("positions %v: DaysToCoverV0 = %v, want %v", tc.positions, got, tc.want)
		}
	}
}

func TestRoundNumeric2Negative(t *testing.T) {
	if got := roundNumeric2(-1.005); got != -1.01 {
		t.Errorf("roundNumeric2(-1.005) = %v, want -1.01 (half away from zero)", got)
	}
}

// TestDaysToCoverV0SpanEdge: the 35-day span includes a bar exactly 35 days
// before asOf and excludes the one before it. Five traded bars from 1 September
// give a mean of 1,000 with the 1st in the span; from the 2nd only four remain.
func TestDaysToCoverV0SpanEdge(t *testing.T) {
	bars := barsFrom(t, "2026-09-01", 5)
	if got, reason := DaysToCoverV0(bars, mustDate(t, "2026-10-06"), 500); reason != "" || got != 0.5 {
		t.Errorf("span starting on the bar: got %v (reason %q), want 0.5", got, reason)
	}
	if _, reason := DaysToCoverV0(bars, mustDate(t, "2026-10-07"), 500); reason != ReasonNoVolume {
		t.Errorf("span starting after the bar: reason %q, want %q", reason, ReasonNoVolume)
	}
}

// TestDaysToCoverV0MatchesSpecParams pins the v0 span and minimum to the
// hashed v0 spec, so a change to either one is a change to the spec.
func TestDaysToCoverV0MatchesSpecParams(t *testing.T) {
	regs := spec.Registry()
	if len(regs) == 0 {
		t.Fatal("no registered spec versions")
	}
	for _, r := range regs {
		if got := r.Spec.Features.Params["dtc_window_days"]; got != dtcV0Days {
			t.Errorf("%s dtc_window_days = %v, constant = %d", r.Spec.StrategyID, got, dtcV0Days)
		}
		if got := r.Spec.Features.Params["dtc_min_rows"]; got != dtcV0MinRows {
			t.Errorf("%s dtc_min_rows = %v, constant = %d", r.Spec.StrategyID, got, dtcV0MinRows)
		}
	}
}

// TestUnpricedRowsSplitTheTwoDaysToCover: a row with volume but a close that is
// not a price (000080 averages it, the price features drop it). sf0 counts the
// row's volume, so five traded rows give a mean of 1,000 and 500 positions cover
// in 0.5 days; four priced rows alone are below its minimum. sf1 skips the row,
// so its 20 priced sessions at 1,000 give 5 days; counting the row as a session
// would put a zero-volume bar in the window and report 5.26.
func TestUnpricedRowsSplitTheTwoDaysToCover(t *testing.T) {
	bars := barsFrom(t, "2026-09-01", 4)
	unpriced := Bar{Date: mustDate(t, "2026-09-05"), Close: 0, High: 0, Low: 0, Volume: 1000}
	bars = append(bars, unpriced)

	asOf := mustDate(t, "2026-09-10")
	if got, reason := DaysToCoverV0(bars, asOf, 500); reason != "" || got != 0.5 {
		t.Errorf("DaysToCoverV0 with an unpriced traded row = %v (reason %q), want 0.5", got, reason)
	}
	if _, reason := DaysToCoverV0(bars[:4], asOf, 500); reason != ReasonNoVolume {
		t.Errorf("DaysToCoverV0 without it: reason %q, want %q", reason, ReasonNoVolume)
	}

	window := barsFrom(t, "2026-08-01", 21)
	for i := range window {
		window[i].Volume = 1000
	}
	window[len(window)-2].Close = 0
	window[len(window)-2].Volume = 0
	window[len(window)-2].High, window[len(window)-2].Low = 0, 0
	last := window[len(window)-1].Date
	got, reason := DaysToCover(window, last, 5_000)
	if reason != "" || math.Abs(got-5) > 1e-9 {
		t.Errorf("DaysToCover = %v (reason %q), want 5: the unpriced zero-volume row is no session", got, reason)
	}
}
