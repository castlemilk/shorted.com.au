package backtest

import (
	"fmt"
	"sort"

	"cloud.google.com/go/civil"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/features"
)

// Window identifiers.
const (
	WindowSinceMay2019    = "since_may_2019"
	WindowSince2023       = "since_2023"
	WindowLast12Months    = "last_12_months"
	WindowLiveSinceFreeze = "live_since_freeze"
)

// The canonical windows' starts. XJT starts on 2019-04-29, so the first full
// month, 2019-05-01, is the first canonical session; 2023 is the first year in
// which ASIC coverage reached 80%.
var (
	windowStartMay2019 = civil.Date{Year: 2019, Month: 5, Day: 1}
	windowStart2023    = civil.Date{Year: 2023, Month: 1, Day: 3}
)

// lastYearDays is the Last 12 months window's length in calendar days.
const lastYearDays = 365

// WindowFigures are one window's metrics, on the window's own sessions.
type WindowFigures struct {
	ID    string
	Label string
	Start civil.Date
	End   civil.Date
	// Sessions is the number of recorded sessions in the window.
	Sessions     int
	CalendarDays int
	Basis        Basis
	// Note is the labelled provenance of the figures: in-sample up to the freeze,
	// recorded after it, or paper track only.
	Note string
	// TotalReturn is shown for every window; NotAnnualised marks a window shorter
	// than CAGRMinCalendarDays, where the return is not annualised.
	TotalReturn    float64
	HasTotalReturn bool
	NotAnnualised  bool
	CAGR           float64
	HasCAGR        bool
	Volatility     float64
	HasVolatility  bool
	Sharpe         SharpeResult
	MaxDrawdown    Drawdown
}

// Chain is the Since windows' curve: the backtest's in-sample curve up to
// live_from − 1, then the paper track from live_from on, scaled so that it starts
// where the backtest stopped: E(t) = E_bt(live_from−1) × paper(t) / paper(start).
// Both curves must carry the same basis, so a price-return curve is never chained
// onto a total-return one.
func Chain(bt, paper Series, liveFrom civil.Date) (Series, error) {
	if bt.Basis != paper.Basis {
		return Series{}, fmt.Errorf("backtest: never chain a %s-return curve onto a %s-return curve", paper.Basis, bt.Basis)
	}
	i := sort.Search(len(bt.Curve.Dates), func(i int) bool { return !bt.Curve.Dates[i].Before(liveFrom) })
	if i == 0 {
		return Series{}, fmt.Errorf("backtest: no in-sample session before live_from %s", liveFrom)
	}
	j := sort.Search(len(paper.Curve.Dates), func(j int) bool { return !paper.Curve.Dates[j].Before(liveFrom) })
	if j == len(paper.Curve.Dates) {
		return Series{}, fmt.Errorf("backtest: the paper track has no session on or after %s", liveFrom)
	}
	base := bt.Curve.Values[i-1]
	start := paper.Curve.Values[j]
	if !(base > 0) || !(start > 0) {
		return Series{}, fmt.Errorf("backtest: cannot chain from a non-positive equity")
	}
	out := Series{Basis: bt.Basis}
	out.Curve.Dates = append(out.Curve.Dates, bt.Curve.Dates[:i]...)
	out.Curve.Values = append(out.Curve.Values, bt.Curve.Values[:i]...)
	for m := j; m < len(paper.Curve.Dates); m++ {
		out.Curve.Dates = append(out.Curve.Dates, paper.Curve.Dates[m])
		out.Curve.Values = append(out.Curve.Values, base*paper.Curve.Values[m]/start)
	}
	return out, nil
}

// Windows returns the four windows of a run. The in-sample curve is cut at
// live_from − 1; when a paper track is given, the Since windows continue on it
// (Chain), and the Live since freeze window is the paper track alone. Without a
// paper track the Since windows end at the freeze, and no figure is shown for
// sessions the backtest has not been frozen against.
//
// cash is the RBA cash rate series of the Sharpe ratio's risk-free rate. A window
// that the series does not cover measures its excess against zero ("risk-free:
// none").
func Windows(bt Series, paper *Series, liveFrom civil.Date, cash []features.RatePoint) ([]WindowFigures, error) {
	var sinceFreeze Series
	chained := Series{Basis: bt.Basis}
	if paper != nil {
		c, err := Chain(bt, *paper, liveFrom)
		if err != nil {
			return nil, err
		}
		chained = c
		sinceFreeze = *paper
	} else {
		chained = truncateBefore(bt, liveFrom)
	}
	if len(chained.Curve.Dates) == 0 {
		return nil, fmt.Errorf("backtest: no sessions to window")
	}
	latest := chained.Curve.Dates[len(chained.Curve.Dates)-1]
	note := fmt.Sprintf("in-sample to %s, recorded after", liveFrom.AddDays(-1))
	if paper == nil {
		note = fmt.Sprintf("in-sample to %s", liveFrom.AddDays(-1))
	}

	var out []WindowFigures
	add := func(id, label string, s Series, from civil.Date, n string) {
		c := sliceFrom(s.Curve, from)
		if len(c.Dates) == 0 {
			return
		}
		out = append(out, figuresOfWindow(id, label, s.Basis, c, cash, n))
	}
	add(WindowSinceMay2019, "Since May 2019", chained, windowStartMay2019, note)
	add(WindowSince2023, "Since 2023", chained, windowStart2023, note)
	add(WindowLast12Months, "Last 12 months", chained, latest.AddDays(-lastYearDays), note)
	if paper != nil {
		add(WindowLiveSinceFreeze, "Live since freeze", sinceFreeze, liveFrom, "paper track only, recorded")
	}
	return out, nil
}

// truncateBefore keeps the sessions before from.
func truncateBefore(s Series, from civil.Date) Series {
	i := sort.Search(len(s.Curve.Dates), func(i int) bool { return !s.Curve.Dates[i].Before(from) })
	return Series{Basis: s.Basis, Curve: Curve{Dates: s.Curve.Dates[:i], Values: s.Curve.Values[:i]}}
}

// sliceFrom is the curve from its first session on or after from.
func sliceFrom(c Curve, from civil.Date) Curve {
	i := sort.Search(len(c.Dates), func(i int) bool { return !c.Dates[i].Before(from) })
	return Curve{Dates: c.Dates[i:], Values: c.Values[i:]}
}

// figuresOfWindow measures one window's curve. The cash series is the window's
// risk-free rate for each return, forward from the first session it covers.
func figuresOfWindow(id, label string, basis Basis, c Curve, cash []features.RatePoint, note string) WindowFigures {
	n := len(c.Dates)
	w := WindowFigures{
		ID: id, Label: label, Basis: basis, Note: note,
		Start: c.Dates[0], End: c.Dates[n-1], Sessions: n,
		CalendarDays: c.Dates[n-1].DaysSince(c.Dates[0]),
	}
	w.TotalReturn, w.HasTotalReturn = TotalReturn(c)
	w.CAGR, w.HasCAGR = CAGR(c)
	w.NotAnnualised = w.HasTotalReturn && !w.HasCAGR
	w.Volatility, w.HasVolatility = Volatility(c)
	w.Sharpe = Sharpe(c, riskFreeSeries(c, cash))
	w.MaxDrawdown = MaxDrawdown(c)
	return w
}

// riskFreeSeries is the daily risk-free rate of each return of c, from the cash
// series. It is nil when the series does not cover the window's first session, so
// the Sharpe ratio reads "risk-free: none".
func riskFreeSeries(c Curve, cash []features.RatePoint) []float64 {
	if len(cash) == 0 || cash[0].Date.After(c.Dates[0]) || len(c.Dates) < 2 {
		return nil
	}
	rf := make([]float64, 0, len(c.Dates)-1)
	for _, d := range c.Dates[1:] {
		rf = append(rf, DailyRate(rateOn(cash, d)/100))
	}
	return rf
}
