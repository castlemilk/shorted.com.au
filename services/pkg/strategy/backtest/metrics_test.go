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

// alternatingCurve has n daily returns alternating +2% and 0%.
func alternatingCurve(n int) Curve {
	values := []float64{100}
	for i := 0; i < n; i++ {
		if i%2 == 0 {
			values = append(values, values[len(values)-1]*1.02)
		} else {
			values = append(values, values[len(values)-1])
		}
	}
	return curveOf(values...)
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

	t.Run("CAGR withheld at 364 days and shown at 365", func(t *testing.T) {
		short := Curve{Dates: []time.Time{base, base.AddDate(0, 0, 364)}, Values: []float64{100, 200}}
		if _, ok := CAGR(short); ok {
			t.Fatal("CAGR shown for a 364-day window")
		}
		year := Curve{Dates: []time.Time{base, base.AddDate(0, 0, 365)}, Values: []float64{100, 200}}
		got, ok := CAGR(year)
		if !ok {
			t.Fatal("CAGR withheld for a 365-day window")
		}
		near(t, "CAGR over 365 days", got, math.Pow(2, 365.25/365)-1, 1e-12)
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

	t.Run("Sharpe and its standard error over 130 returns", func(t *testing.T) {
		// 130 daily returns alternating +2% and 0%, against a zero risk-free series.
		c := alternatingCurve(130)
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
			rets[i] = c.Values[i+1]/c.Values[i] - 1
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
	})

	t.Run("Sharpe shown from 126 returns and withheld at 125", func(t *testing.T) {
		if got := Sharpe(alternatingCurve(126), nil); !got.Shown || got.SE == 0 {
			t.Fatalf("126 returns: shown %v SE %v, want shown with a standard error", got.Shown, got.SE)
		}
		if got := Sharpe(alternatingCurve(125), nil); got.Shown || got.SE != 0 {
			t.Fatalf("125 returns: shown %v SE %v, want withheld", got.Shown, got.SE)
		}
	})

	t.Run("Sharpe withheld under 126 returns", func(t *testing.T) {
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
	})

	t.Run("Sharpe measures excess over cash", func(t *testing.T) {
		// Returns alternate +2% and 0%. The cash series is a constant 4% a year,
		// so each excess is the return less that day's rate. The ratio is taken
		// on the excess, not on the return.
		c := alternatingCurve(130)
		rfDaily := DailyRate(0.04)
		rf := make([]float64, 130)
		for i := range rf {
			rf[i] = rfDaily
		}
		got := Sharpe(c, rf)
		if got.RiskFreeNone {
			t.Fatal("a full risk-free series was reported as none")
		}
		excess := make([]float64, 130)
		m := 0.0
		for i := range excess {
			excess[i] = c.Values[i+1]/c.Values[i] - 1 - rfDaily
			m += excess[i]
		}
		m /= 130
		near(t, "daily Sharpe on the excess", got.Daily, m/sampleStdevForTest(excess), 1e-12)

		// Adding the rate instead of subtracting it, or ignoring it, must give a
		// different ratio.
		plus := make([]float64, 130)
		for i := range plus {
			plus[i] = -rfDaily
		}
		if math.Abs(Sharpe(c, plus).Daily-got.Daily) < 1e-6 {
			t.Fatal("subtracting and adding the cash rate give the same Sharpe")
		}
		if math.Abs(Sharpe(c, make([]float64, 130)).Daily-got.Daily) < 1e-6 {
			t.Fatal("ignoring the cash rate gives the same Sharpe")
		}
	})

	t.Run("closed-trade statistics", func(t *testing.T) {
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
	})

	t.Run("mean exposure", func(t *testing.T) {
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
	})

	t.Run("turnover and costs paid over one year", func(t *testing.T) {
		// 252 sessions at a constant 100,000. One round trip: 1,000 units bought
		// and sold at 10 (20,000 of notional) and A$15 paid on each fill.
		recs := make([]Record, TradingDaysPerYear)
		for i := range recs {
			recs[i] = Record{Equity: 100000}
		}
		trades := []Trade{{Qty: 1000, EntryPrice: 10, ExitPrice: 10, Fees: 30}}
		turnover, ok := Turnover(trades, recs)
		if !ok {
			t.Fatal("turnover not ok")
		}
		near(t, "turnover", turnover, 20000/100000.0/2, 1e-12)
		costs, ok := CostsPaid(trades, recs)
		if !ok {
			t.Fatal("costs not ok")
		}
		near(t, "costs paid", costs, 30/100000.0, 1e-12)
	})

	t.Run("turnover withheld without sessions", func(t *testing.T) {
		if _, ok := Turnover(nil, nil); ok {
			t.Fatal("turnover shown with no sessions")
		}
		if _, ok := CostsPaid(nil, nil); ok {
			t.Fatal("costs shown with no sessions")
		}
	})
}
