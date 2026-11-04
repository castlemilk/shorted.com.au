package features

import (
	"math"

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
// away from zero), and the result rounded to two places. It is unknown with
// fewer than 5 traded sessions in the span.
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
	return math.Round(positions/avg*100) / 100, ""
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
