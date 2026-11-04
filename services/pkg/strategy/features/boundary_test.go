package features

import (
	"math"
	"testing"

	"cloud.google.com/go/civil"
)

// Inclusive and exact boundaries of the price features. Each test sits on the
// edge of one rule, so an off-by-one in the port fails a case, not only the
// container parity (which compares the fixtures' own boundaries).

// A volume of exactly 1.5 times the average is a breakout; one share less is not.
func TestBreakoutVolumeBoundaryIsInclusive(t *testing.T) {
	last := day(t, "2024-03-29")
	for _, c := range []struct {
		volume float64
		want   bool
	}{{150, true}, {149, false}} {
		bars := series(last, 60, func(i int) Bar {
			if i == 59 {
				return Bar{Open: 10, High: 11, Low: 10, Close: 11, AdjClose: 11, Volume: c.volume}
			}
			return flatBar(10, 100)
		})
		got, ok := AsOf(bars, nil, last, v0FS1(t))
		if !ok {
			t.Fatal("expected features")
		}
		if got.BreakoutRecent != c.want {
			t.Errorf("volume %v: breakout = %v, want %v", c.volume, got.BreakoutRecent, c.want)
		}
	}
}

// The window is [D-400, D], both ends inclusive. Sixty sessions with the oldest
// on D-400 are a full window; the same sixty with the oldest on D-401 are not
// (only 59 sessions fall inside).
func TestWindowStartIsInclusiveAtFourHundredDays(t *testing.T) {
	last := day(t, "2024-03-29")
	from := last.AddDays(-400)
	build := func(oldest civil.Date) []Bar {
		tail := series(last, 59, func(int) Bar { return flatBar(10, 100) })
		return append([]Bar{{Date: oldest, Open: 10, High: 10, Low: 10, Close: 10, AdjClose: 10, Volume: 100}}, tail...)
	}
	if _, ok := AsOf(build(from), nil, last, v0FS1(t)); !ok {
		t.Fatal("a bar dated D-400 is inside the window: 60 sessions must produce features")
	}
	if _, ok := AsOf(build(from.AddDays(-1)), nil, last, v0FS1(t)); ok {
		t.Fatal("a bar dated D-401 is outside the window: 59 sessions must not produce features")
	}
}

// The index close used for RS must be within 7 days at each end. Eight days
// stale is NULL and seven is kept, at the stock's own as_of (x0) and at its
// three-month anchor (xN).
func TestRelativeStrengthSevenDayBoundaryAtEachEnd(t *testing.T) {
	asOf := day(t, "2024-03-29")
	anchor := day(t, "2023-12-29")
	ret := 4.0
	for _, c := range []struct {
		name       string
		endStale   int // XJO bar this many days before as_of (x0)
		startStale int // XJO bar this many days before the anchor (xN)
		want       bool
	}{
		{"x0 seven days stale", 7, 0, true},
		{"x0 eight days stale", 8, 0, false},
		{"xN seven days stale", 0, 7, true},
		{"xN eight days stale", 0, 8, false},
	} {
		xjo := []IndexBar{
			{Date: anchor.AddDays(-c.startStale), Close: 100},
			{Date: asOf.AddDays(-c.endStale), Close: 110},
		}
		if c.startStale == 0 {
			xjo[0].Date = anchor
		}
		if c.endStale == 0 {
			xjo[1].Date = asOf
		}
		got := relativeStrength(&ret, anchor, true, asOf, xjo, 7)
		if (got != nil) != c.want {
			t.Errorf("%s: rs known = %v, want %v", c.name, got != nil, c.want)
		}
	}
}

// An unusable index close on the lookup date is not a close: the lookup takes
// the newest usable one before it. The RS then uses that earlier close.
func TestRelativeStrengthSkipsAnUnusableIndexClose(t *testing.T) {
	asOf := day(t, "2024-03-29")
	anchor := day(t, "2023-12-29")
	ret := 4.0
	nan := math.NaN()
	xjo := []IndexBar{
		{Date: anchor.AddDays(-3), Close: 100},
		{Date: anchor, Close: nan},
		{Date: asOf, Close: 110},
	}
	got := relativeStrength(&ret, anchor, true, asOf, xjo, 7)
	if got == nil {
		t.Fatal("rs must use the usable close three days before the anchor")
	}
	// Variables, not constants: a constant expression is folded exactly, not in float64.
	var usable, now = 100.0, 110.0
	want := ret - float64((now/usable-1)*100)
	if *got != want {
		t.Fatalf("rs = %v, want %v from the close of %s", *got, want, anchor.AddDays(-3))
	}
}

// A trailing 1-month or 3-month return is withheld when its anchor session is
// more than 10 days before the calendar target, and kept at exactly 10 days.
func TestCalendarReturnToleranceIsTenDays(t *testing.T) {
	asOf := day(t, "2024-03-29")
	bound := minusMonths(asOf, 1) // 2024-02-29
	for _, c := range []struct {
		stale int
		want  bool
	}{{10, true}, {11, false}} {
		pts := []pt{
			{date: bound.AddDays(-c.stale), close: 10},
			{date: asOf, close: 11},
		}
		ret, _, _, ok := calendarReturn(pts, asOf, 1, 10, 11)
		if !ok {
			t.Fatalf("stale %d: the anchor session exists, so the lookup is found", c.stale)
		}
		if (ret != nil) != c.want {
			t.Errorf("anchor %d days before the target: return known = %v, want %v", c.stale, ret != nil, c.want)
		}
	}
}
