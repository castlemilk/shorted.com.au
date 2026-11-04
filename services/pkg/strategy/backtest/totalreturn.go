package backtest

import (
	"math"
	"time"
)

// TradingDaysPerYear annualises daily returns and rates.
const TradingDaysPerYear = 252

// Rounding quanta of the total-return basis. Prices were stored to cents until
// the 4-decimal migration, so a cents-era bar carries a wider tolerance.
const (
	quantumCents       = 0.005
	quantumFourDP      = 0.00005
	toleranceFloor     = 0.001
	maxTotalReturnStep = 1.15
)

// BarBasis is the per-bar total-return decision. It reads the previous loaded
// bar and this one only, so it is point-in-time.
type BarBasis struct {
	// HasPrev is false for a code's first loaded bar. Nothing is decided then:
	// the multiplier stays at 1 and no cash dividend is credited.
	HasPrev bool
	// RK is ln((adj_t/close_t) / (adj_{t-1}/close_{t-1})), the vendor's
	// adjustment step on this bar.
	RK float64
	// Tol is the rounding tolerance for this bar.
	Tol float64
	// TotalReturn is true when the multiplier moves by RK on this bar. A bar
	// that is not total-return is price-return: its step is ignored.
	TotalReturn bool
	// Unadjusted is true when RK <= Tol, the vendor did not adjust the bar, so a
	// cash dividend recorded on it is credited in cash.
	Unadjusted bool
}

// Quantum is the rounding quantum for a bar dated on date: cents before
// price4dpFrom, four decimal places from it on.
func Quantum(date, price4dpFrom time.Time) float64 {
	if date.Before(price4dpFrom) {
		return quantumCents
	}
	return quantumFourDP
}

// ClassifyBar applies the per-bar rule to cur, given the previous loaded bar.
// A bar with a non-positive close or adjusted close, against a previous bar that
// exists, is price-return: the step cannot be measured, so it is not trusted.
func ClassifyBar(prev, cur Bar, hasPrev bool, date, price4dpFrom time.Time) BarBasis {
	if !hasPrev {
		return BarBasis{}
	}
	if prev.Close <= 0 || prev.Adj <= 0 || cur.Close <= 0 || cur.Adj <= 0 {
		return BarBasis{HasPrev: true}
	}
	q := Quantum(date, price4dpFrom)
	rk := math.Log((cur.Adj / cur.Close) / (prev.Adj / prev.Close))
	tol := toleranceFloor + float64(q*(1/cur.Adj+1/cur.Close+1/prev.Adj+1/prev.Close))
	return BarBasis{
		HasPrev:     true,
		RK:          rk,
		Tol:         tol,
		TotalReturn: rk >= -tol && rk <= math.Log(maxTotalReturnStep),
		Unadjusted:  rk <= tol,
	}
}

// DailyRate converts an annual cash rate into the rate earned in one session:
// (1+r)^(1/252) - 1.
func DailyRate(annual float64) float64 {
	return math.Pow(1+annual, 1.0/TradingDaysPerYear) - 1
}
