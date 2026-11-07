package features

import (
	"math"
	"testing"

	"cloud.google.com/go/civil"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/engine"
	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/spec"
)

// indexSeries returns n consecutive XJO sessions ending on last, the close of
// the bar at position i (0 oldest) from close.
func indexSeries(last civil.Date, n int, close func(i int) float64) []IndexBar {
	first := last.AddDays(-(n - 1))
	out := make([]IndexBar, n)
	for i := range out {
		c := close(i)
		out[i] = IndexBar{Date: first.AddDays(i), High: c, Low: c, Close: c}
	}
	return out
}

func TestRegimeLabels(t *testing.T) {
	last := day(t, "2024-09-30")
	cases := []struct {
		name  string
		n     int
		close func(i int) float64
		want  string
	}{
		// Rising: close above both averages, the fast one above the slow one.
		{"uptrend", 250, func(i int) float64 { return float64(i + 1) }, engine.RegimeUptrend},
		// Falling: the close below the 200-session average.
		{"downtrend", 250, func(i int) float64 { return float64(250 - i) }, engine.RegimeDowntrend},
		// 100 sessions at 200, 99 at 100, then 160. The 50-session average is
		// 101.2 and the 200-session average is 150.3. The close is above the
		// 200-session average, but the 50 is below it, so the label is neutral:
		// above the slow average and not an uptrend.
		{"neutral", 200, func(i int) float64 {
			switch {
			case i < 100:
				return 200
			case i < 199:
				return 100
			}
			return 160
		}, engine.RegimeNeutral},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := Regime(indexSeries(last, c.n, c.close), last)
			if got.Label != c.want {
				t.Fatalf("label = %q, want %q (sma50 %v sma200 %v close %v)", got.Label, c.want, got.SMA50, got.SMA200, got.Close)
			}
			if got.IndexCode != engine.DefaultIndexCode || !got.Known() {
				t.Fatalf("index %q known %v", got.IndexCode, got.Known())
			}
		})
	}
}

// Fewer than 200 sessions: the 200-session average is unknown, so the label is
// unknown too (empty), which every regime rule reads as unknown.
func TestRegimeIsUnknownWithoutTwoHundredSessions(t *testing.T) {
	last := day(t, "2024-09-30")
	got := Regime(indexSeries(last, 199, func(i int) float64 { return float64(i + 1) }), last)
	if got.SMA200 != nil || got.Label != "" || got.Known() {
		t.Fatalf("sma200 %v label %q, want NULL and unknown", got.SMA200, got.Label)
	}
	if got.SMA50 == nil {
		t.Fatal("the 50-session average has its window and should be known")
	}
}

// Index bars after D do not move the regime at D.
func TestRegimeIgnoresBarsAfterTheSession(t *testing.T) {
	last := day(t, "2024-09-30")
	base := indexSeries(last, 250, func(i int) float64 { return float64(i + 1) })
	want := Regime(base, last)
	extended := append([]IndexBar{}, base...)
	extended = append(extended,
		IndexBar{Date: last.AddDays(1), Close: 9999},
		IndexBar{Date: last.AddDays(2), Close: -1},
	)
	if got := Regime(extended, last); !regimeEqual(got, want) {
		t.Fatalf("regime read past D:\n got %+v\nwant %+v", got, want)
	}
}

// Inside the window, an index close that is NULL, NaN, zero or infinite is not
// a session, and a high that is not a finite positive number reads as the
// close. The bad values are placed in the 52-week range and in the averages'
// windows, where any of them would change the regime if it were read.
func TestRegimeSkipsUnusableClosesAndHighsInsideTheWindow(t *testing.T) {
	last := day(t, "2024-09-30")
	junk := indexSeries(last, 250, func(i int) float64 { return float64(i + 1) })
	junk[240].Close = math.NaN()
	junk[230].Close = 0
	junk[100].Close = math.Inf(1)
	junk[200].High = math.Inf(1)
	junk[150].High = math.NaN()
	junk[60].High = -5

	// The same series with the unusable sessions removed, and the bad highs
	// replaced by their close: the regime must read the two identically.
	var clean []IndexBar
	for i, b := range junk {
		switch i {
		case 240, 230, 100:
			continue
		case 200, 150, 60:
			b.High = b.Close
		}
		clean = append(clean, b)
	}
	if got, want := Regime(junk, last), Regime(clean, last); !regimeEqual(got, want) {
		t.Fatalf("unusable index values moved the regime:\n got %+v\nwant %+v", got, want)
	}
	if got := Regime(junk, last); got.PctOff52wHigh == nil || math.IsNaN(*got.PctOff52wHigh) {
		t.Fatalf("pct_off_52w_high = %v, want a finite value", got.PctOff52wHigh)
	}
}

// The regime's windows are the v0 specs' regime and fs1 literals.
func TestRegimeWindowsMatchSpec(t *testing.T) {
	for _, reg := range spec.Registry() {
		if !reg.Live {
			continue
		}
		if reg.Spec.Regime.SMAFast != regimeSMAFast || reg.Spec.Regime.SMASlow != regimeSMASlow {
			t.Errorf("%s: regime averages %d/%d, package has %d/%d",
				reg.Spec.StrategyID, reg.Spec.Regime.SMAFast, reg.Spec.Regime.SMASlow, regimeSMAFast, regimeSMASlow)
		}
		if got := reg.Spec.Features.Params["history_calendar_days"]; got != regimeHistoryDays {
			t.Errorf("%s: history %v, package has %d", reg.Spec.StrategyID, got, regimeHistoryDays)
		}
		if got := reg.Spec.Features.Params["ret_anchor_tolerance_days"]; int(got) != regimeTolerance {
			t.Errorf("%s: tolerance %v, package has %d", reg.Spec.StrategyID, got, regimeTolerance)
		}
		if got := reg.Spec.Features.Params["high_low_sessions"]; int(got) != regimeHigh52Ranks {
			t.Errorf("%s: 52-week ranks %v, package has %d", reg.Spec.StrategyID, got, regimeHigh52Ranks)
		}
	}
}

func regimeEqual(a, b engine.Regime) bool {
	return a.IndexCode == b.IndexCode && a.Label == b.Label && ptrEqual(a.Close, b.Close) &&
		ptrEqual(a.SMA50, b.SMA50) && ptrEqual(a.SMA200, b.SMA200) &&
		ptrEqual(a.PctOff52wHigh, b.PctOff52wHigh) && ptrEqual(a.Ret1mPct, b.Ret1mPct) &&
		ptrEqual(a.Ret3mPct, b.Ret3mPct) && (a.AsOf == nil) == (b.AsOf == nil) && (a.AsOf == nil || a.AsOf.Equal(*b.AsOf))
}

func ptrEqual(a, b *float64) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}
