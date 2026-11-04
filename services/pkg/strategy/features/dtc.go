package features

import (
	"math"
	"math/big"
	"strconv"

	"cloud.google.com/go/civil"
)

const (
	// dtcBars is the averaging window of sf1's days to cover: the last 20
	// sessions, zero-volume sessions included.
	dtcBars = 20
	// dtcMinTraded is the fewest traded sessions the sf1 window may hold.
	dtcMinTraded = 10
	// dtcV0Days is the calendar span sf0's average covers.
	dtcV0Days = 35
	// dtcV0MinRows is the fewest traded sessions sf0's average needs.
	dtcV0MinRows = 5
)

// DaysToCover is sf1's days to cover at asOf: the reported positions over the
// mean daily volume of the last 20 bars up to asOf. A zero-volume bar is a
// session with no trading, so it counts in the mean as zero rather than being
// skipped; skipping it would overstate the volume a short position has to be
// covered from. The value is unknown with fewer than 20 bars or fewer than 10
// traded bars in the window. reason is empty when the value is known.
func DaysToCover(bars []Bar, asOf civil.Date, positions float64) (value float64, reason string) {
	window := barsUpTo(bars, asOf)
	if len(window) < dtcBars {
		return 0, ReasonNoVolume
	}
	window = window[len(window)-dtcBars:]
	traded := 0
	sum := 0.0
	for _, b := range window {
		if b.Volume > 0 {
			traded++
			sum += b.Volume
		}
	}
	if traded < dtcMinTraded {
		return 0, ReasonNoVolume
	}
	return positions / (sum / dtcBars), ""
}

// DaysToCoverV0 is sf0's days to cover: positions over the average daily volume
// of traded sessions in the 35 calendar days up to asOf, with that average
// rounded to a whole share count the way 000080's bigint cast rounds it (half
// away from zero), and the result rounded to two places the way 000080's
// numeric rounding does (see roundNumeric2). It is unknown with fewer than 5
// traded sessions in the span.
func DaysToCoverV0(bars []Bar, asOf civil.Date, positions float64) (value float64, reason string) {
	from := asOf.AddDays(-dtcV0Days)
	n := 0
	sum := 0.0
	for _, b := range bars {
		if b.Date.Before(from) || b.Date.After(asOf) {
			continue
		}
		if b.Volume > 0 {
			n++
			sum += b.Volume
		}
	}
	if n < dtcV0MinRows {
		return 0, ReasonNoVolume
	}
	avg := math.Round(sum / float64(n))
	if avg < 1 {
		return 0, ReasonNoVolume
	}
	return roundNumeric2(positions / avg), ""
}

// roundNumeric2 rounds q to two places as PostgreSQL rounds round(float8::numeric,
// 2): the float is first written with 15 significant digits, then that decimal
// is rounded half away from zero. Rounding the binary value directly differs at
// exact half-cent quotients (201 over 200 is 1.01 in the database, and a binary
// round gives 1.00), which is more than the parity tolerance.
func roundNumeric2(q float64) float64 {
	if !finite(q) {
		return q
	}
	dec, ok := new(big.Rat).SetString(strconv.FormatFloat(q, 'g', 15, 64))
	if !ok {
		return math.Round(q*100) / 100
	}
	neg := dec.Sign() < 0
	dec.Abs(dec)
	// floor(x*100 + 1/2) for x >= 0, in integers: (2*100*num + den) / (2*den).
	num := new(big.Int).Mul(dec.Num(), big.NewInt(200))
	num.Add(num, dec.Denom())
	cents := new(big.Int).Quo(num, new(big.Int).Mul(dec.Denom(), big.NewInt(2)))
	v := float64(cents.Int64()) / 100
	if neg {
		return -v
	}
	return v
}

// barsUpTo returns the prefix of bars dated on or before asOf. bars must be
// date ascending.
func barsUpTo(bars []Bar, asOf civil.Date) []Bar {
	end := len(bars)
	for end > 0 && bars[end-1].Date.After(asOf) {
		end--
	}
	return bars[:end]
}
