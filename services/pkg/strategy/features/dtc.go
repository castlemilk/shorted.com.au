package features

import (
	"math"
	"strconv"
	"strings"

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
// round gives 1.00), which is more than the parity tolerance. The rounding is
// done on the decimal digits, so no quotient overflows.
func roundNumeric2(q float64) float64 {
	if !finite(q) {
		return q
	}
	// 15 significant digits: d.dddddddddddddd e exp, so the value is
	// digits x 10^(exp-14), and its hundredths are digits x 10^(exp-12).
	mant, expText, _ := strings.Cut(strconv.FormatFloat(math.Abs(q), 'e', 14, 64), "e")
	exp, err := strconv.Atoi(expText)
	if err != nil {
		return math.Round(q*100) / 100
	}
	digits := strings.Replace(mant, ".", "", 1)
	cents := digits + strings.Repeat("0", max(exp-12, 0))
	if shift := -(exp - 12); shift > 0 {
		if len(digits) <= shift {
			digits = strings.Repeat("0", shift+1-len(digits)) + digits
		}
		kept := digits[:len(digits)-shift]
		if digits[len(digits)-shift] >= '5' {
			kept = incrementDecimal(kept)
		}
		cents = kept
	}
	cents = strings.TrimLeft(cents, "0")
	for len(cents) < 3 {
		cents = "0" + cents
	}
	v, err := strconv.ParseFloat(cents[:len(cents)-2]+"."+cents[len(cents)-2:], 64)
	if err != nil {
		return math.Round(q*100) / 100
	}
	if q < 0 {
		return -v
	}
	return v
}

// incrementDecimal adds one to a string of decimal digits.
func incrementDecimal(s string) string {
	b := []byte(s)
	for i := len(b) - 1; i >= 0; i-- {
		if b[i] < '9' {
			b[i]++
			return string(b)
		}
		b[i] = '0'
	}
	return "1" + string(b)
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
