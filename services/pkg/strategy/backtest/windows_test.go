package backtest

import (
	"math"
	"strings"
	"testing"

	"cloud.google.com/go/civil"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/features"
)

// dailyCurve is one value per calendar day from start, n days, of v(k).
func dailyCurve(start civil.Date, n int, v func(k int) float64) Curve {
	c := Curve{}
	for k := 0; k < n; k++ {
		c.Dates = append(c.Dates, start.AddDays(k))
		c.Values = append(c.Values, v(k))
	}
	return c
}

// TestChainScalesThePaperTrackFromTheFreeze: from live_from the chained curve is
// the in-sample value at the freeze times the paper track over its own start, so
// it is continuous at the freeze and carries the paper track's returns after it.
func TestChainScalesThePaperTrackFromTheFreeze(t *testing.T) {
	live := civil.Date{Year: 2025, Month: 6, Day: 2}
	bt := Series{Basis: BasisTotal, Curve: dailyCurve(live.AddDays(-30), 60, func(k int) float64 { return 100 + float64(k) })}
	paper := Series{Basis: BasisTotal, Curve: dailyCurve(live.AddDays(-5), 20, func(k int) float64 { return 50 + 2*float64(k) })}
	got, err := Chain(bt, paper, live)
	if err != nil {
		t.Fatal(err)
	}
	// The in-sample value on the session before the freeze.
	base := bt.Curve.Values[29]
	for i, d := range got.Curve.Dates {
		if d.Before(live) {
			continue
		}
		pIdx := d.DaysSince(paper.Curve.Dates[0])
		want := base * paper.Curve.Values[pIdx] / paper.Curve.Values[5]
		if math.Abs(got.Curve.Values[i]-want) > 1e-9 {
			t.Fatalf("%s chained %v, want %v", d, got.Curve.Values[i], want)
		}
	}
	// No in-sample session after the freeze survives into the chained curve.
	for _, d := range got.Curve.Dates {
		if d.After(live.AddDays(-1)) && d.Before(paper.Curve.Dates[5]) {
			t.Fatalf("session %s between the freeze and the paper start was kept", d)
		}
	}
}

// TestChainNeverMixesBases: a price-return curve is never chained onto a
// total-return one.
func TestChainNeverMixesBases(t *testing.T) {
	live := civil.Date{Year: 2025, Month: 6, Day: 2}
	bt := Series{Basis: BasisTotal, Curve: dailyCurve(live.AddDays(-10), 10, func(k int) float64 { return 100 })}
	paper := Series{Basis: BasisPrice, Curve: dailyCurve(live, 5, func(k int) float64 { return 100 })}
	if _, err := Chain(bt, paper, live); err == nil || !strings.Contains(err.Error(), "never chain") {
		t.Fatalf("chain across bases: err %v, want a refusal", err)
	}
}

// TestCAGRIsShownOnlyForAWholeYear: a window of 365 calendar days or more is
// annualised; a shorter one reports its total return and is marked not annualised.
func TestCAGRIsShownOnlyForAWholeYear(t *testing.T) {
	start := civil.Date{Year: 2024, Month: 1, Day: 2}
	for _, c := range []struct {
		days       int
		annualised bool
	}{{364, false}, {365, true}, {400, true}} {
		curve := Curve{Dates: []civil.Date{start, start.AddDays(c.days)}, Values: []float64{100, 110}}
		w := figuresOfWindow("x", "x", BasisTotal, curve, nil, "")
		if w.HasCAGR != c.annualised {
			t.Fatalf("%d days: HasCAGR %v, want %v", c.days, w.HasCAGR, c.annualised)
		}
		if w.NotAnnualised == c.annualised || !w.HasTotalReturn {
			t.Fatalf("%d days: not annualised %v with total return %v", c.days, w.NotAnnualised, w.HasTotalReturn)
		}
	}
}

// TestSharpeIsShownFromAHalfYearOfReturns: a Sharpe ratio is shown from 126 daily
// returns, and not before.
func TestSharpeIsShownFromAHalfYearOfReturns(t *testing.T) {
	for _, n := range []int{SharpeMinReturns - 1, SharpeMinReturns} {
		curve := dailyCurve(civil.Date{Year: 2024, Month: 1, Day: 2}, n+1, func(k int) float64 {
			if k%2 == 0 {
				return 100
			}
			return 101
		})
		s := Sharpe(curve, nil)
		if s.N != n {
			t.Fatalf("N %d, want %d", s.N, n)
		}
		if s.Shown != (n >= SharpeMinReturns) {
			t.Fatalf("%d returns: shown %v", n, s.Shown)
		}
	}
}

// TestWindowsStartsFollowTheDefinitions: the Last 12 months window begins on the
// first session on or after the latest session less 365 days, and a window the
// cash series does not cover reads risk-free: none.
func TestWindowsStartsFollowTheDefinitions(t *testing.T) {
	start := civil.Date{Year: 2019, Month: 4, Day: 29}
	n := 3000
	bt := Series{Basis: BasisTotal, Curve: dailyCurve(start, n, func(k int) float64 { return 100 + float64(k)/10 })}
	live := civil.Date{Year: 2027, Month: 1, Day: 1}
	// The cash series starts on 2024-01-01, after the 2019 window, so the Since
	// windows have no risk-free rate.
	cash := []features.RatePoint{{Date: civil.Date{Year: 2024, Month: 1, Day: 1}, Rate: 4}}
	ws, err := Windows(bt, nil, live, cash)
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string]WindowFigures{}
	for _, w := range ws {
		byID[w.ID] = w
	}
	// The in-sample curve stops the day before the freeze, so that is the latest.
	latest := live.AddDays(-1)
	for !contains(bt.Curve.Dates, latest) {
		latest = latest.AddDays(-1)
	}
	last12 := byID[WindowLast12Months]
	if want := latest.AddDays(-365); last12.Start.Before(want) || last12.Start.After(want.AddDays(3)) {
		t.Fatalf("last 12 months starts %s, want the first session from %s", last12.Start, want)
	}
	if last12.End != latest {
		t.Fatalf("last 12 months ends %s, want %s", last12.End, latest)
	}
	if got := byID[WindowSince2023].Start; got != (civil.Date{Year: 2023, Month: 1, Day: 3}) {
		t.Fatalf("since 2023 starts %s", got)
	}
	if !byID[WindowSinceMay2019].Sharpe.RiskFreeNone {
		t.Fatalf("a window the cash series does not cover must read risk-free: none")
	}
	if _, ok := byID[WindowLiveSinceFreeze]; ok {
		t.Fatalf("the live window needs a paper track")
	}
}

// TestWindowsWithoutAPaperTrackStopAtTheFreeze: with no paper track the windows
// end on the freeze's eve, labelled in-sample, and carry no figure after it.
func TestWindowsWithoutAPaperTrackStopAtTheFreeze(t *testing.T) {
	start := civil.Date{Year: 2024, Month: 1, Day: 2}
	bt := Series{Basis: BasisTotal, Curve: dailyCurve(start, 800, func(k int) float64 { return 100 + float64(k) })}
	live := civil.Date{Year: 2025, Month: 1, Day: 2}
	ws, err := Windows(bt, nil, live, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, w := range ws {
		if !w.End.Before(live) {
			t.Fatalf("%s ends %s, on or after the freeze", w.ID, w.End)
		}
		if !strings.HasPrefix(w.Note, "in-sample to ") {
			t.Fatalf("%s note %q is not labelled in-sample", w.ID, w.Note)
		}
	}
}

// TestWindowsWithAPaperTrackChainAndAddTheLiveWindow: the Since windows run
// through the freeze on the paper track, and the live window is the paper track.
func TestWindowsWithAPaperTrackChainAndAddTheLiveWindow(t *testing.T) {
	start := civil.Date{Year: 2024, Month: 1, Day: 2}
	live := civil.Date{Year: 2025, Month: 1, Day: 2}
	bt := Series{Basis: BasisTotal, Curve: dailyCurve(start, 400, func(k int) float64 { return 100 + float64(k) })}
	paper := &Series{Basis: BasisTotal, Curve: dailyCurve(live, 100, func(k int) float64 { return 100 + 0.5*float64(k) })}
	ws, err := Windows(bt, paper, live, nil)
	if err != nil {
		t.Fatal(err)
	}
	var sawLive bool
	for _, w := range ws {
		if w.ID == WindowLiveSinceFreeze {
			sawLive = true
			if w.Start != live || w.Note != "paper track only, recorded" {
				t.Fatalf("live window %+v", w)
			}
		} else if !strings.Contains(w.Note, "recorded after") {
			t.Fatalf("%s note %q does not carry the freeze", w.ID, w.Note)
		}
	}
	if !sawLive {
		t.Fatalf("no live since freeze window")
	}
}

// contains reports whether the sorted dates hold d.
func contains(dates []civil.Date, d civil.Date) bool {
	for _, x := range dates {
		if x == d {
			return true
		}
	}
	return false
}
