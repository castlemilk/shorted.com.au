package backtest

import (
	"math"
	"testing"
	"time"
)

// curveOf builds a curve on consecutive calendar days from base.
func curveOf(values ...float64) Curve {
	c := Curve{}
	for i, v := range values {
		c.Dates = append(c.Dates, dayAt(i))
		c.Values = append(c.Values, v)
	}
	return c
}

func TestMetrics(t *testing.T) {
	t.Run("total return", func(t *testing.T) {
		got, ok := TotalReturn(curveOf(100, 150))
		if !ok {
			t.Fatal("not ok")
		}
		near(t, "total return", got, 0.5, 1e-12)
	})

	t.Run("CAGR over exactly four years", func(t *testing.T) {
		// 1461 calendar days is four years, so 365.25/1461 = 1/4 and 2x is 2^(1/4).
		c := Curve{
			Dates:  []time.Time{base, base.AddDate(4, 0, 0)},
			Values: []float64{100, 200},
		}
		got, ok := CAGR(c)
		if !ok {
			t.Fatal("CAGR not shown for a four-year window")
		}
		near(t, "CAGR", got, math.Pow(2, 0.25)-1, 1e-12)
	})

	t.Run("CAGR withheld under 365 days", func(t *testing.T) {
		c := Curve{Dates: []time.Time{base, base.AddDate(0, 0, 364)}, Values: []float64{100, 200}}
		if _, ok := CAGR(c); ok {
			t.Fatal("CAGR shown for a 364-day window")
		}
	})

	t.Run("max drawdown with peak, trough and recovery", func(t *testing.T) {
		// Peak 130 at index 4, trough 60 at index 5, back to 130 at index 6.
		d := MaxDrawdown(curveOf(100, 120, 90, 110, 130, 60, 150))
		near(t, "depth", d.Depth, 60.0/130-1, 1e-12)
		if d.Peak != 4 || d.Trough != 5 || d.Recovery != 6 {
			t.Fatalf("peak %d trough %d recovery %d, want 4 5 6", d.Peak, d.Trough, d.Recovery)
		}
	})

	t.Run("max drawdown not recovered", func(t *testing.T) {
		d := MaxDrawdown(curveOf(100, 80))
		if d.Recovery != -1 {
			t.Fatalf("recovery %d, want -1", d.Recovery)
		}
	})

	t.Run("max drawdown none", func(t *testing.T) {
		d := MaxDrawdown(curveOf(100, 110, 120))
		if d.Depth != 0 || d.Trough != -1 {
			t.Fatalf("a rising curve reported depth %v trough %d", d.Depth, d.Trough)
		}
	})

	t.Run("volatility", func(t *testing.T) {
		c := curveOf(100, 101, 100, 101)
		// Returns: +1%, -0.990099%, +1%.
		rets := []float64{101.0/100 - 1, 100.0/101 - 1, 101.0/100 - 1}
		want := sampleStdevForTest(rets) * math.Sqrt(252)
		got, ok := Volatility(c)
		if !ok {
			t.Fatal("volatility not ok")
		}
		near(t, "volatility", got, want, 1e-12)
	})
}

// sampleStdevForTest is an independent stdev (n-1) for the fixtures.
func sampleStdevForTest(xs []float64) float64 {
	m := 0.0
	for _, x := range xs {
		m += x
	}
	m /= float64(len(xs))
	ss := 0.0
	for _, x := range xs {
		ss += (x - m) * (x - m)
	}
	return math.Sqrt(ss / float64(len(xs)-1))
}

func TestSharpeAndItsStandardError(t *testing.T) {
	// 130 daily returns alternating +2% and 0%, against a zero risk-free series.
	values := []float64{100}
	for i := 0; i < 130; i++ {
		if i%2 == 0 {
			values = append(values, values[len(values)-1]*1.02)
		} else {
			values = append(values, values[len(values)-1])
		}
	}
	c := curveOf(values...)
	rf := make([]float64, 130)

	got := Sharpe(c, rf)
	if got.N != 130 || !got.Shown {
		t.Fatalf("N %d shown %v, want 130 and shown", got.N, got.Shown)
	}
	if got.RiskFreeNone {
		t.Fatal("a zero risk-free series was reported as none")
	}

	rets := make([]float64, 130)
	for i := range rets {
		rets[i] = values[i+1]/values[i] - 1
	}
	m := 0.0
	for _, x := range rets {
		m += x
	}
	m /= 130
	daily := m / sampleStdevForTest(rets)
	near(t, "daily Sharpe", got.Daily, daily, 1e-12)
	near(t, "annual Sharpe", got.Annual, daily*math.Sqrt(252), 1e-9)
	wantSE := math.Sqrt((1+daily*daily/2)/130) * math.Sqrt(252)
	near(t, "Lo 2002 standard error", got.SE, wantSE, 1e-9)
}

func TestSharpeWithheldUnder126Returns(t *testing.T) {
	c := curveOf(100, 101, 100, 101, 100)
	got := Sharpe(c, nil)
	if got.Shown {
		t.Fatal("Sharpe shown for four returns")
	}
	if got.SE != 0 {
		t.Fatalf("standard error %v shown for four returns", got.SE)
	}
	if !got.RiskFreeNone {
		t.Fatal("no risk-free series was not reported as none")
	}
}

func TestSharpeMeasuresExcessOverCash(t *testing.T) {
	// Excess returns are r_t - rf_t. A risk-free series equal to every return
	// leaves no excess, so the ratio is zero rather than undefined.
	values := []float64{100}
	for i := 0; i < 130; i++ {
		values = append(values, values[len(values)-1]*1.01)
	}
	c := curveOf(values...)
	rf := make([]float64, 130)
	for i := range rf {
		rf[i] = values[i+1]/values[i] - 1
	}
	got := Sharpe(c, rf)
	if got.RiskFreeNone {
		t.Fatal("a full risk-free series was reported as none")
	}
	near(t, "Sharpe with no excess", got.Daily, 0, 1e-12)
}

func TestTradeSummary(t *testing.T) {
	trades := []Trade{
		{Net: 0.10, SessionsHeld: 5},
		{Net: -0.05, SessionsHeld: 10},
		{Net: 0.02, SessionsHeld: 15},
		{Net: 0, SessionsHeld: 20},
		{Net: 0.50, SessionsHeld: 99, OpenAtEnd: true},
	}
	s := Summarise(trades)
	if s.Closed != 4 {
		t.Fatalf("closed %d, want 4 (open trade excluded)", s.Closed)
	}
	near(t, "win rate", s.WinRate, 0.5, 1e-12)
	near(t, "average win", s.AvgWin, 0.06, 1e-12)
	near(t, "average loss", s.AvgLoss, -0.025, 1e-12)
	if !s.ProfitFactorOK {
		t.Fatal("profit factor not ok with losses")
	}
	near(t, "profit factor", s.ProfitFactor, 0.12/0.05, 1e-12)
	near(t, "average hold", s.AverageHold, 12.5, 1e-12)
}

func TestMeanExposure(t *testing.T) {
	recs := []Record{
		{Equity: 100, Invested: 50},
		{Equity: 100, Invested: 100},
		{Equity: 100, Invested: 0},
	}
	got, ok := MeanExposure(recs)
	if !ok {
		t.Fatal("exposure not ok")
	}
	near(t, "mean exposure", got, 0.5, 1e-12)
}
