package features

import (
	"math"
	"reflect"
	"testing"

	"cloud.google.com/go/civil"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
)

// v0FS1 is the feature parameters of the registered v0 specs: the literals of
// migration 000130 that the engine evaluates with.
func v0FS1(t *testing.T) spec.FeatureSpec {
	t.Helper()
	reg, ok := spec.Live("zanger-breakout")
	if !ok {
		t.Fatal("no live spec for zanger-breakout")
	}
	return reg.Spec.Features
}

func day(t *testing.T, s string) civil.Date {
	t.Helper()
	d, err := civil.ParseDate(s)
	if err != nil {
		t.Fatalf("ParseDate(%q): %v", s, err)
	}
	return d
}

// series returns n consecutive calendar sessions ending on last, the bar at
// position i (0 is the oldest) coming from bar.
func series(last civil.Date, n int, bar func(i int) Bar) []Bar {
	first := last.AddDays(-(n - 1))
	out := make([]Bar, n)
	for i := range out {
		b := bar(i)
		b.Date = first.AddDays(i)
		out[i] = b
	}
	return out
}

// flatBar is a bar whose open, high, low and close are all c.
func flatBar(c, v float64) Bar {
	return Bar{Open: c, High: c, Low: c, Close: c, AdjClose: c, Volume: v}
}

func ptr(v float64) *float64 { return &v }

// approx is true when a and b agree to 1e-9 relative (the parity tolerance).
func approx(a, b float64) bool {
	if a == b {
		return true
	}
	return math.Abs(a-b) <= 1e-9*math.Max(1, math.Max(math.Abs(a), math.Abs(b)))
}

func wantPtr(t *testing.T, name string, got *float64, want float64) {
	t.Helper()
	if got == nil {
		t.Fatalf("%s = nil, want %v", name, want)
	}
	if !approx(*got, want) {
		t.Fatalf("%s = %v, want %v", name, *got, want)
	}
}

func wantNil(t *testing.T, name string, got *float64) {
	t.Helper()
	if got != nil {
		t.Fatalf("%s = %v, want NULL", name, *got)
	}
}

func TestAsOfNeedsSixtySessions(t *testing.T) {
	last := day(t, "2024-06-03")
	fs := v0FS1(t)
	if _, ok := AsOf(series(last, 59, func(int) Bar { return flatBar(10, 100) }), nil, last, fs); ok {
		t.Fatal("59 sessions must not produce features")
	}
	got, ok := AsOf(series(last, 60, func(int) Bar { return flatBar(10, 100) }), nil, last, fs)
	if !ok {
		t.Fatal("60 sessions must produce features")
	}
	if got.SessionsAvailable != 60 || got.AsOf.Compare(last) != 0 {
		t.Fatalf("sessions_available = %d, as_of = %s", got.SessionsAvailable, got.AsOf)
	}
}

func TestSMAsNeedTheirFullWindow(t *testing.T) {
	last := day(t, "2024-09-30")
	fs := v0FS1(t)
	// Closes 1..150 oldest to newest: rank 1 is 150.
	got, ok := AsOf(series(last, 150, func(i int) Bar { return flatBar(float64(i+1), 100) }), nil, last, fs)
	if !ok {
		t.Fatal("150 sessions must produce features")
	}
	wantPtr(t, "sma10", got.SMA10, 145.5)
	wantPtr(t, "sma20", got.SMA20, 140.5)
	wantPtr(t, "sma150", got.SMA150, 75.5)
	if got.SMA200 != nil || got.SMA200OneMonthAgo != nil {
		t.Fatal("sma200 and sma200_1m_ago need 200 and 221 sessions")
	}
	if got.PrevClose == nil || *got.PrevClose != 149 || got.Close != 150 {
		t.Fatalf("close %v prev_close %v, want 150 and 149", got.Close, got.PrevClose)
	}
}

func TestSMA200OneMonthAgoNeedsRank221(t *testing.T) {
	last := day(t, "2024-12-31")
	fs := v0FS1(t)
	// 221 sessions, closes 1..221; rank 1 is 221, rank 22..221 is 1..200.
	got, ok := AsOf(series(last, 221, func(i int) Bar { return flatBar(float64(i+1), 100) }), nil, last, fs)
	if !ok {
		t.Fatal("221 sessions must produce features")
	}
	wantPtr(t, "sma200", got.SMA200, 121.5)
	wantPtr(t, "sma200_1m_ago", got.SMA200OneMonthAgo, 100.5)
	if got.SessionsAvailable != 221 {
		t.Fatalf("sessions_available = %d, want 221", got.SessionsAvailable)
	}
}

// Sixty flat sessions at 10 on 100 shares, then a close of 11 on 200 shares.
// The newest session clears the prior 40-session high of 10 on 2x the prior
// 50-session volume, so it is a breakout at rank 1 and the base is anchored
// there: the pivot is 10, the base is flat at 10, and it runs the full 40
// sessions back.
func TestBreakoutAnchorsTheBaseAtTheBreakoutSession(t *testing.T) {
	last := day(t, "2024-03-29")
	fs := v0FS1(t)
	bars := series(last, 60, func(i int) Bar {
		if i == 59 {
			return Bar{Open: 10, High: 11, Low: 10, Close: 11, AdjClose: 11, Volume: 200}
		}
		return flatBar(10, 100)
	})
	got, ok := AsOf(bars, nil, last, fs)
	if !ok {
		t.Fatal("expected features")
	}
	if !got.BreakoutRecent || got.BreakoutDate == nil || got.BreakoutDate.Compare(last) != 0 {
		t.Fatalf("breakout_recent %v breakout_date %v, want true on %s", got.BreakoutRecent, got.BreakoutDate, last)
	}
	wantPtr(t, "base_high", got.BaseHigh, 10)
	wantPtr(t, "base_low", got.BaseLow, 10)
	wantPtr(t, "base_depth_pct", got.BaseDepthPct, 0)
	if got.BaseLengthDays == nil || *got.BaseLengthDays != 40 {
		t.Fatalf("base_length_days = %v, want 40 (a flat base counts its full window)", got.BaseLengthDays)
	}
	// Volume ratio: 200 over the prior 50 sessions' 100.
	wantPtr(t, "avg_volume_50d", got.AvgVolume50d, 100)
	wantPtr(t, "volume_ratio_50d", got.VolumeRatio50d, 2)
	// Dollar volume over the newest 20: 11*200 once, then 10*100 nineteen times.
	wantPtr(t, "dollar_volume_20d", got.DollarVolume20d, (11*200+19*10*100)/20.0)
}

// The same series with 149 shares on the last session: 1.5x the prior average
// is 150, so the close above the high is not a breakout.
func TestBreakoutNeedsOneAndAHalfTimesTheVolume(t *testing.T) {
	last := day(t, "2024-03-29")
	bars := series(last, 60, func(i int) Bar {
		if i == 59 {
			return Bar{Open: 10, High: 11, Low: 10, Close: 11, AdjClose: 11, Volume: 149}
		}
		return flatBar(10, 100)
	})
	got, ok := AsOf(bars, nil, last, v0FS1(t))
	if !ok {
		t.Fatal("expected features")
	}
	if got.BreakoutRecent || got.BreakoutDate != nil {
		t.Fatalf("breakout = %v on %v, want none", got.BreakoutRecent, got.BreakoutDate)
	}
	// Without a breakout the anchor is rank 1 and the pivot is still the prior high.
	wantPtr(t, "base_high", got.BaseHigh, 10)
}

// Two breakouts in the newest five sessions. The base is anchored at the
// EARLIEST one (rank 5, the close of 11), while breakout_date reports the
// LATEST (rank 2, the close of 12). Anchoring at the later one would read a
// pivot of 11.
func TestAnchorIsTheEarliestBreakoutAndDateIsTheLatest(t *testing.T) {
	last := day(t, "2024-03-29")
	bars := series(last, 60, func(i int) Bar {
		switch i {
		case 55: // rank 5
			return Bar{Open: 10, High: 11, Low: 10, Close: 11, AdjClose: 11, Volume: 200}
		case 58: // rank 2
			return Bar{Open: 11, High: 12, Low: 11, Close: 12, AdjClose: 12, Volume: 200}
		}
		return flatBar(10, 100)
	})
	got, ok := AsOf(bars, nil, last, v0FS1(t))
	if !ok {
		t.Fatal("expected features")
	}
	if got.BreakoutDate == nil || *got.BreakoutDate != bars[58].Date {
		t.Fatalf("breakout_date = %v, want the rank-2 session %s", got.BreakoutDate, bars[58].Date)
	}
	wantPtr(t, "base_high", got.BaseHigh, 10)
	if got.BaseLengthDays == nil || *got.BaseLengthDays != 40 {
		t.Fatalf("base_length_days = %v, want 40 from the rank-5 anchor", got.BaseLengthDays)
	}
}

// The base's low is the lowest low of the 40 sessions after the anchor. The
// length is the distance to the oldest of those sessions whose high is within
// 2% of the pivot: every session here touches 10, so the oldest is rank 41.
func TestBaseLowAndLengthReadTheSessionsAfterTheAnchor(t *testing.T) {
	last := day(t, "2024-03-29")
	bars := series(last, 60, func(i int) Bar {
		switch {
		case i == 59:
			return Bar{Open: 10, High: 11, Low: 10, Close: 11, AdjClose: 11, Volume: 200}
		case i == 30: // a dip inside the base window, an old session
			return Bar{Open: 10, High: 10, Low: 9, Close: 9.5, AdjClose: 9.5, Volume: 100}
		case i == 25: // a session well below the touch band; does not set the length
			return Bar{Open: 9, High: 9, Low: 9, Close: 9, AdjClose: 9, Volume: 100}
		}
		return flatBar(10, 100)
	})
	got, ok := AsOf(bars, nil, last, v0FS1(t))
	if !ok {
		t.Fatal("expected features")
	}
	wantPtr(t, "base_low", got.BaseLow, 9)
	// Pivot 10: the touch band is high >= 9.8, and the base window is ranks
	// 2..41. The oldest session in it with a high in the band is rank 41, so the
	// length is 41 - 1 = 40.
	if got.BaseLengthDays == nil || *got.BaseLengthDays != 40 {
		t.Fatalf("base_length_days = %v, want 40", got.BaseLengthDays)
	}
	wantPtr(t, "base_depth_pct", got.BaseDepthPct, (10.0-9)/10*100)
}

func TestNonPriceRowsAreDropped(t *testing.T) {
	last := day(t, "2024-03-29")
	bars := series(last, 60, func(i int) Bar { return flatBar(10, 100) })
	// A close above the storage ceiling and a NaN close are not prices.
	bars = append(bars, Bar{Date: last.AddDays(1), Close: 1e9, High: 1e9, Low: 1e9, Volume: 1})
	bars = append(bars, Bar{Date: last.AddDays(2), Close: math.NaN(), High: math.NaN(), Low: math.NaN(), Volume: 1})
	got, ok := AsOf(bars, nil, last.AddDays(2), v0FS1(t))
	if !ok {
		t.Fatal("expected features from the 60 valid sessions")
	}
	if got.SessionsAvailable != 60 || got.Close != 10 {
		t.Fatalf("sessions_available %d close %v, want 60 valid sessions ending at 10", got.SessionsAvailable, got.Close)
	}
}

// Invalid highs and lows fall back to the close: a NaN high, a zero low and
// an over-ceiling high leave the 52-week range at the close.
func TestInvalidHighsAndLowsFallBackToTheClose(t *testing.T) {
	last := day(t, "2024-03-29")
	bars := series(last, 60, func(i int) Bar {
		b := flatBar(10, 100)
		switch i {
		case 10:
			b.High = math.NaN()
		case 20:
			b.Low = 0
		case 30:
			b.High = 1e9
		}
		return b
	})
	got, ok := AsOf(bars, nil, last, v0FS1(t))
	if !ok {
		t.Fatal("expected features")
	}
	wantPtr(t, "high_52w", got.High52w, 10)
	wantPtr(t, "low_52w", got.Low52w, 10)
}

func TestNegativeVolumeReadsAsZero(t *testing.T) {
	last := day(t, "2024-03-29")
	bars := series(last, 60, func(i int) Bar {
		if i == 59 {
			return Bar{Open: 10, High: 10, Low: 10, Close: 10, AdjClose: 10, Volume: -5}
		}
		return flatBar(10, 100)
	})
	got, ok := AsOf(bars, nil, last, v0FS1(t))
	if !ok {
		t.Fatal("expected features")
	}
	if got.Volume != 0 {
		t.Fatalf("volume = %v, want 0", got.Volume)
	}
}

// Calendar returns use the last session on or before as-of minus N months, and
// a return is withheld when that session is more than 10 days before the target.
func TestCalendarReturnsAgainstTheCalendarAnchor(t *testing.T) {
	last := day(t, "2024-03-29")
	// 120 consecutive sessions, closes rising from 2 to 4.
	bars := series(last, 120, func(i int) Bar {
		return flatBar(2+2*float64(i)/119, 100)
	})
	got, ok := AsOf(bars, nil, last, v0FS1(t))
	if !ok {
		t.Fatal("expected features")
	}
	// 2024-03-29 less one month is 2024-02-29, which is bar 90; less three
	// months is 2023-12-29, which is bar 28.
	if bars[90].Date != day(t, "2024-02-29") || bars[28].Date != day(t, "2023-12-29") {
		t.Fatalf("test calendar is off: bars %s and %s", bars[90].Date, bars[28].Date)
	}
	now := bars[119].Close
	wantPtr(t, "ret_1m_pct", got.Ret1mPct, (now/bars[90].Close-1)*100)
	wantPtr(t, "ret_3m_pct", got.Ret3mPct, (now/bars[28].Close-1)*100)
}

// The 1-month anchor is the last session on or before 2024-02-29, which here is
// 2024-02-10: 19 days early. That is a gap, not a return.
func TestCalendarReturnIsWithheldAcrossAGap(t *testing.T) {
	last := day(t, "2024-03-29")
	var bars []Bar
	for d := day(t, "2023-12-01"); !d.After(day(t, "2024-02-10")); d = d.AddDays(1) {
		bars = append(bars, flatBar(10, 100))
		bars[len(bars)-1].Date = d
	}
	for d := day(t, "2024-03-15"); !d.After(last); d = d.AddDays(1) {
		bars = append(bars, flatBar(10, 100))
		bars[len(bars)-1].Date = d
	}
	got, ok := AsOf(bars, nil, last, v0FS1(t))
	if !ok {
		t.Fatal("expected features")
	}
	if got.Ret1mPct != nil {
		t.Fatalf("ret_1m_pct = %v across a 19-day gap, want NULL", *got.Ret1mPct)
	}
	if got.Ret3mPct == nil {
		t.Fatal("ret_3m_pct has a session on its anchor and should be known")
	}
}

// RS is the stock's return less the XJO's over the same window. A flat index
// gives RS equal to the stock's own return.
func TestRelativeStrengthAgainstTheIndex(t *testing.T) {
	last := day(t, "2024-03-29")
	bars := series(last, 120, func(i int) Bar { return flatBar(10+float64(i)/10, 100) })
	idx := make([]IndexBar, 120)
	for i := range idx {
		idx[i] = IndexBar{Date: bars[i].Date, High: 100, Low: 100, Close: 100}
	}
	got, ok := AsOf(bars, idx, last, v0FS1(t))
	if !ok {
		t.Fatal("expected features")
	}
	if got.Ret3mPct == nil {
		t.Fatal("ret_3m_pct should be known with a full history")
	}
	wantPtr(t, "rs_3m_pct", got.RS3mPct, *got.Ret3mPct)
	// Six months back is before the 120 sessions held, so the 6-month return
	// and its RS are unknown.
	if got.Ret6mPct != nil || got.RS6mPct != nil {
		t.Fatalf("6-month figures without 6 months of history: ret %v rs %v", got.Ret6mPct, got.RS6mPct)
	}
}

// The index must have a usable close within 7 days of each end of the window.
// A three-week-old last index close gives no RS.
func TestRelativeStrengthNeedsAnIndexWithinSevenDays(t *testing.T) {
	last := day(t, "2024-03-29")
	bars := series(last, 120, func(i int) Bar { return flatBar(10+float64(i)/10, 100) })
	var idx []IndexBar
	for i := 0; i < 120; i++ {
		d := last.AddDays(-(119 - i))
		if d.After(last.AddDays(-21)) {
			continue // no index bars in the last 3 weeks
		}
		idx = append(idx, IndexBar{Date: d, Close: 100})
	}
	got, ok := AsOf(bars, idx, last, v0FS1(t))
	if !ok {
		t.Fatal("expected features")
	}
	if got.RS3mPct != nil || got.RS6mPct != nil {
		t.Fatalf("rs must be NULL with the index 21 days stale, got %v / %v", got.RS3mPct, got.RS6mPct)
	}
}

// Bars after D never change the features at D: AsOf(bars[:i+1], d_i) equals
// AsOf(bars, d_i) for every i. A linear-congruential series makes the values
// irregular enough to expose a leak.
func TestFeaturesIgnoreFutureBars(t *testing.T) {
	start := day(t, "2023-01-02")
	const n = 330
	state := uint32(7)
	next := func() float64 {
		state = state*1664525 + 1013904223
		return float64(state%10000)/100 + 1
	}
	bars := make([]Bar, n)
	xjo := make([]IndexBar, 0, n)
	for i := range bars {
		c := next()
		bars[i] = Bar{Date: start.AddDays(i), Open: c, High: c + next()/50, Low: c - next()/50, Close: c, AdjClose: c, Volume: float64(int(next()) * 10)}
		xjo = append(xjo, IndexBar{Date: start.AddDays(i), High: 7000 + float64(i), Low: 6990 + float64(i), Close: 7000 + float64(i)/2})
	}
	fs := v0FS1(t)
	checked := 0
	for i := 59; i < n; i++ {
		d := bars[i].Date
		prefix, okPrefix := AsOf(bars[:i+1], xjo[:i+1], d, fs)
		full, okFull := AsOf(bars, xjo, d, fs)
		if okPrefix != okFull || !reflect.DeepEqual(prefix, full) {
			t.Fatalf("session %s: features read the future\nprefix %+v\nfull   %+v", d, prefix, full)
		}
		checked++
	}
	if checked < 200 {
		t.Fatalf("only %d sessions checked", checked)
	}
}

// The month clamp follows PostgreSQL: 31 March less a month is the last day of
// February, and the day never overflows into the next month.
func TestMinusMonthsClampsToTheMonthEnd(t *testing.T) {
	cases := []struct {
		from string
		n    int
		want string
	}{
		{"2024-03-31", 1, "2024-02-29"},
		{"2024-03-30", 1, "2024-02-29"},
		{"2024-03-29", 1, "2024-02-29"},
		{"2024-05-31", 3, "2024-02-29"},
		{"2024-02-29", 12, "2023-02-28"},
		{"2024-01-31", 1, "2023-12-31"},
		{"2024-08-31", 6, "2024-02-29"},
		{"2019-04-23", 1, "2019-03-23"},
	}
	for _, c := range cases {
		got := minusMonths(day(t, c.from), c.n)
		if got.String() != c.want {
			t.Errorf("minusMonths(%s, %d) = %s, want %s", c.from, c.n, got, c.want)
		}
	}
}

func TestCandidatesOutsideTheWindowAreIgnored(t *testing.T) {
	last := day(t, "2024-03-29")
	// A bar more than 400 calendar days before D is outside the history window.
	old := Bar{Date: last.AddDays(-401), Open: 1, High: 1, Low: 1, Close: 1, AdjClose: 1, Volume: 1}
	bars := append([]Bar{old}, series(last, 59, func(int) Bar { return flatBar(10, 100) })...)
	if _, ok := AsOf(bars, nil, last, v0FS1(t)); ok {
		t.Fatal("a bar 401 days back must not count toward the 60 sessions")
	}
}

func TestSpecParametersAreRead(t *testing.T) {
	fs := v0FS1(t)
	fs.Params = map[string]float64{}
	defer func() {
		if recover() == nil {
			t.Fatal("a feature spec without its parameters must panic, not compute with guessed windows")
		}
	}()
	AsOf(nil, nil, day(t, "2024-03-29"), fs)
}

// The volume averages need their own minimums: the 20-session dollar volume
// needs 10 sessions, and the 50-session average volume needs 20 of its 50. At
// the default 60-session floor those never bite, so the floor is lowered on a
// copy of the v0 parameters to reach them.
func TestVolumeAverageMinimums(t *testing.T) {
	last := day(t, "2024-03-29")
	fs := v0FS1(t)
	params := map[string]float64{}
	for k, v := range fs.Params {
		params[k] = v
	}
	params["min_sessions"] = 5
	fs.Params = params

	cases := []struct {
		sessions    int
		wantDollar  bool // 10 of the newest 20
		wantAverage bool // 20 of the 50 before the newest
	}{
		{9, false, false},
		{12, true, false},
		{21, true, true},
	}
	for _, c := range cases {
		bars := series(last, c.sessions, func(int) Bar { return flatBar(10, 100) })
		got, ok := AsOf(bars, nil, last, fs)
		if !ok {
			t.Fatalf("%d sessions with min_sessions 5 must produce features", c.sessions)
		}
		if (got.DollarVolume20d != nil) != c.wantDollar {
			t.Errorf("%d sessions: dollar_volume_20d present = %v, want %v", c.sessions, got.DollarVolume20d != nil, c.wantDollar)
		}
		if (got.AvgVolume50d != nil) != c.wantAverage {
			t.Errorf("%d sessions: avg_volume_50d present = %v, want %v", c.sessions, got.AvgVolume50d != nil, c.wantAverage)
		}
	}
}
