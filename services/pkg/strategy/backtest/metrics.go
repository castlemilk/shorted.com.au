package backtest

import (
	"math"

	"cloud.google.com/go/civil"
)

const (
	// CAGRMinCalendarDays is the shortest window that is annualised. Shorter
	// windows report total return only.
	CAGRMinCalendarDays = 365
	// SharpeMinReturns is the fewest daily returns a Sharpe ratio is shown for.
	SharpeMinReturns = 126
	// sharpeZeroSD is the excess-return spread below which a Sharpe ratio is not
	// measurable. Real daily excess returns are orders of magnitude larger.
	sharpeZeroSD = 1e-12
)

// Curve is a daily series of closing equity with its session dates.
type Curve struct {
	Dates  []civil.Date
	Values []float64
}

// EquityCurve is the equity curve of recorded sessions.
func EquityCurve(recs []Record) Curve {
	c := Curve{Dates: make([]civil.Date, 0, len(recs)), Values: make([]float64, 0, len(recs))}
	for _, r := range recs {
		c.Dates = append(c.Dates, r.Date)
		c.Values = append(c.Values, r.Equity)
	}
	return c
}

// TotalReturn is E_end/E_start - 1. It is false when the start is not positive.
func TotalReturn(c Curve) (float64, bool) {
	n := len(c.Values)
	if n < 2 || c.Values[0] <= 0 {
		return 0, false
	}
	return c.Values[n-1]/c.Values[0] - 1, true
}

// CAGR is (E_end/E_start)^(365.25/calendar days) - 1. It is shown only for a
// window of at least CAGRMinCalendarDays calendar days.
func CAGR(c Curve) (float64, bool) {
	n := len(c.Values)
	if n < 2 || c.Values[0] <= 0 || c.Values[n-1] <= 0 {
		return 0, false
	}
	days := calendarDays(c.Dates[0], c.Dates[n-1])
	if days < CAGRMinCalendarDays {
		return 0, false
	}
	return math.Pow(c.Values[n-1]/c.Values[0], 365.25/float64(days)) - 1, true
}

func calendarDays(from, to civil.Date) int {
	return to.DaysSince(from)
}

// Drawdown is the deepest peak-to-trough fall of a curve. Indices refer to the
// curve's values. Recovery is the first index back at the peak, or -1 when the
// curve has not recovered. Depth is zero, and the indices -1, when the curve
// never falls.
type Drawdown struct {
	Depth    float64
	Peak     int
	Trough   int
	Recovery int
}

// MaxDrawdown measures the deepest fall of min_t(E_t / max_{s<=t} E_s - 1).
func MaxDrawdown(c Curve) Drawdown {
	d := Drawdown{Peak: -1, Trough: -1, Recovery: -1}
	if len(c.Values) == 0 {
		return d
	}
	peak := 0
	for i, v := range c.Values {
		if v > c.Values[peak] {
			peak = i
		}
		if dd := v/c.Values[peak] - 1; dd < d.Depth {
			d.Depth, d.Peak, d.Trough = dd, peak, i
		}
	}
	if d.Trough < 0 {
		return d
	}
	for j := d.Trough + 1; j < len(c.Values); j++ {
		if c.Values[j] >= c.Values[d.Peak] {
			d.Recovery = j
			break
		}
	}
	return d
}

// dailyReturns is r_t = E_t/E_{t-1} - 1. A non-positive prior value yields zero
// rather than a non-finite return.
func dailyReturns(values []float64) []float64 {
	if len(values) < 2 {
		return nil
	}
	r := make([]float64, 0, len(values)-1)
	for i := 1; i < len(values); i++ {
		if values[i-1] <= 0 {
			r = append(r, 0)
			continue
		}
		r = append(r, values[i]/values[i-1]-1)
	}
	return r
}

func mean(xs []float64) float64 {
	if len(xs) == 0 {
		return 0
	}
	sum := 0.0
	for _, x := range xs {
		sum += x
	}
	return sum / float64(len(xs))
}

// sampleStdev divides by n-1.
func sampleStdev(xs []float64) float64 {
	if len(xs) < 2 {
		return 0
	}
	m := mean(xs)
	ss := 0.0
	for _, x := range xs {
		ss += float64((x - m) * (x - m))
	}
	return math.Sqrt(ss / float64(len(xs)-1))
}

// Volatility is stdev(r_t) x sqrt(252). It is false with fewer than two returns.
func Volatility(c Curve) (float64, bool) {
	r := dailyReturns(c.Values)
	if len(r) < 2 {
		return 0, false
	}
	return sampleStdev(r) * math.Sqrt(TradingDaysPerYear), true
}

// SharpeResult is a Sharpe ratio on excess daily returns.
type SharpeResult struct {
	// N is the number of daily returns.
	N int
	// Daily is mean(e_t)/stdev(e_t), with e_t the excess return.
	Daily float64
	// Annual is Daily x sqrt(252).
	Annual float64
	// SE is the Lo (2002) standard error of Annual under i.i.d. returns:
	// sqrt((1 + SR_d^2/2)/n) x sqrt(252). It is zero unless Shown.
	SE float64
	// Shown is false below SharpeMinReturns returns, and when the excess return
	// has no spread (a 0/0 ratio), where the ratio is not reported ("n/m").
	Shown bool
	// RiskFreeNone is true when the cash series does not cover the window, so
	// the excess is measured against zero.
	RiskFreeNone bool
}

// Sharpe is the Sharpe ratio of daily returns over the daily risk-free rates
// rf, one rate per return. A nil or mismatched rf means no risk-free series.
func Sharpe(c Curve, rf []float64) SharpeResult {
	r := dailyReturns(c.Values)
	res := SharpeResult{N: len(r)}
	if len(r) < 2 {
		res.RiskFreeNone = true
		return res
	}
	useRF := len(rf) == len(r)
	res.RiskFreeNone = !useRF
	excess := make([]float64, len(r))
	for i := range r {
		excess[i] = r[i]
		if useRF {
			excess[i] -= rf[i]
		}
	}
	// A window with no spread in its excess return (an all-cash window, where the
	// excess is zero up to rounding) has a 0/0 ratio, so it is not measured.
	sd := sampleStdev(excess)
	measurable := sd > sharpeZeroSD
	if measurable {
		res.Daily = mean(excess) / sd
	}
	res.Annual = res.Daily * math.Sqrt(TradingDaysPerYear)
	res.Shown = len(r) >= SharpeMinReturns && measurable
	if res.Shown {
		n := float64(len(r))
		half := float64(float64(res.Daily*res.Daily) / 2)
		res.SE = math.Sqrt((1+half)/n) * math.Sqrt(TradingDaysPerYear)
	}
	return res
}

// TradeSummary is the closed-trade statistics of a run. Trades still open at
// the window end are excluded.
type TradeSummary struct {
	Closed int
	// WinRate is closed trades with a net return above zero, over Closed.
	WinRate float64
	// AvgWin and AvgLoss are the mean net return of winners and of the others.
	AvgWin  float64
	AvgLoss float64
	// ProfitFactor is the sum of winning net returns over the absolute sum of
	// losing ones. It is valid when ProfitFactorOK, which needs a loss.
	ProfitFactor   float64
	ProfitFactorOK bool
	// AverageHold is the mean number of sessions held over closed trades.
	AverageHold float64
}

// Summarise computes the closed-trade statistics of trades.
func Summarise(trades []Trade) TradeSummary {
	var s TradeSummary
	var wins, losses int
	var winSum, lossSum, holdSum float64
	for _, t := range trades {
		if t.OpenAtEnd {
			continue
		}
		s.Closed++
		holdSum += float64(t.SessionsHeld)
		if t.Net > 0 {
			wins++
			winSum += t.Net
		} else {
			losses++
			lossSum += t.Net
		}
	}
	if s.Closed == 0 {
		return s
	}
	s.WinRate = float64(wins) / float64(s.Closed)
	s.AverageHold = holdSum / float64(s.Closed)
	if wins > 0 {
		s.AvgWin = winSum / float64(wins)
	}
	if losses > 0 {
		s.AvgLoss = lossSum / float64(losses)
		s.ProfitFactor = winSum / -lossSum
		s.ProfitFactorOK = lossSum < 0
	}
	return s
}

// MeanExposure is the mean over sessions of invested value divided by equity.
// It is false when no session is recorded.
func MeanExposure(recs []Record) (float64, bool) {
	if len(recs) == 0 {
		return 0, false
	}
	sum := 0.0
	for _, r := range recs {
		if r.Equity > 0 {
			sum += r.Invested / r.Equity
		}
	}
	return sum / float64(len(recs)), true
}

// Turnover is the annualised fill notional over average equity, halved: a round
// trip is two fills and the figure is one side of it. Entries count at their
// notional and closed exits at their proceeds. It is false when no session is
// recorded or average equity is not positive.
func Turnover(trades []Trade, recs []Record) (float64, bool) {
	avg, years, ok := averageEquity(recs)
	if !ok {
		return 0, false
	}
	notional := 0.0
	for _, t := range trades {
		notional += float64(t.Qty * t.EntryPrice)
		if !t.OpenAtEnd {
			notional += float64(t.Qty * t.ExitPrice)
		}
	}
	return notional / years / avg / 2, true
}

// CostsPaid is the total of every fill's brokerage and spread, annualised over
// average equity. It is false when no session is recorded or average equity is
// not positive.
func CostsPaid(trades []Trade, recs []Record) (float64, bool) {
	avg, years, ok := averageEquity(recs)
	if !ok {
		return 0, false
	}
	fees := 0.0
	for _, t := range trades {
		fees += t.Fees
	}
	return fees / years / avg, true
}

// averageEquity is the mean recorded equity and the window's length in years of
// TradingDaysPerYear sessions.
func averageEquity(recs []Record) (avg, years float64, ok bool) {
	if len(recs) == 0 {
		return 0, 0, false
	}
	sum := 0.0
	for _, r := range recs {
		sum += r.Equity
	}
	avg = sum / float64(len(recs))
	if avg <= 0 {
		return 0, 0, false
	}
	return avg, float64(len(recs)) / TradingDaysPerYear, true
}
