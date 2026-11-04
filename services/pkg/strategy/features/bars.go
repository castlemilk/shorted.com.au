// Package features computes the price, market-regime and short-position
// features the strategy engine reads. Every function is a pure function of the
// rows it is given: the caller reads the rows (pgsource, or a backtest's
// in-memory copy) and passes them in, so live and backtest run the same code.
//
// The price features and the regime are exact ports of migration 000130's
// mv_price_features and mv_market_regime, evaluated at any session D instead of
// CURRENT_DATE. The container parity test holds the port to the view at fixed
// anchors.
package features

import (
	"math"
	"time"

	"cloud.google.com/go/civil"
)

// priceCeiling is the largest price a stored row may carry (DECIMAL(10,2)'s
// maximum, which the views filter on). A value above it, and a NaN, is not a
// price: the close drops the row, and a high or low falls back to the close.
const priceCeiling = 99999999.99

// Bar is one stock_prices row, as the features read it. Date is the trading
// session; the prices are float64 (the readers convert from NUMERIC with
// ::float8, so the values match the views' comparisons). Volume is the share
// count (BIGINT in storage); NULL reads as 0.
type Bar struct {
	Date     civil.Date
	Open     float64
	High     float64
	Low      float64
	Close    float64
	AdjClose float64
	Volume   float64
}

// IndexBar is one index_prices row (XJO, XJT). Index levels carry no volume.
type IndexBar struct {
	Date  civil.Date
	High  float64
	Low   float64
	Close float64
}

// pt is one bar of a window after the views' clamping: the high and low are
// the valid stored values or the close, and the volume is never negative.
type pt struct {
	date   civil.Date
	close  float64
	high   float64
	low    float64
	volume float64
}

// validPrice reports whether a stored close is one the price features read:
// positive and no larger than the storage ceiling. NaN fails both tests.
func validPrice(c float64) bool {
	return c > 0 && c <= priceCeiling
}

// stockPoint applies the price-feature clamping to one stock bar (000130's px
// CTE). The caller has already dropped bars that fail validPrice.
func stockPoint(b Bar) pt {
	high := b.Close
	if b.High > 0 && b.High <= priceCeiling && b.High > high {
		high = b.High
	}
	low := b.Close
	if b.Low > 0 && b.Low <= priceCeiling && b.Low < low {
		low = b.Low
	}
	volume := b.Volume
	if !(volume >= 0) {
		volume = 0
	}
	return pt{date: b.Date, close: b.Close, high: high, low: low, volume: volume}
}

// indexPoint applies the regime's clamping to one index bar (000130's ix CTE):
// the regime admits any finite positive close and any finite positive high, so
// its range is wider than the stock's. NaN fails every comparison.
func indexPoint(b IndexBar) pt {
	high := b.Close
	if b.High > 0 && b.High < math.Inf(1) && b.High > high {
		high = b.High
	}
	return pt{date: b.Date, close: b.Close, high: high, low: b.Close}
}

// indexUsable reports whether an index close is one the views read: positive
// and finite (the views' `close > 0 AND close < 'Infinity'`).
func indexUsable(c float64) bool {
	return c > 0 && c < math.Inf(1)
}

// minusMonths is PostgreSQL's `date - interval 'n months'`: the month moves and
// the day clamps to the end of the target month (31 March less one month is 28
// or 29 February). It is never time.AddDate, which overflows into the next month.
func minusMonths(d civil.Date, n int) civil.Date {
	total := d.Year*12 + int(d.Month) - 1 - n
	year := total / 12
	month := time.Month(total%12 + 1)
	day := d.Day
	if last := time.Date(year, month+1, 0, 0, 0, 0, 0, time.UTC).Day(); day > last {
		day = last
	}
	return civil.Date{Year: year, Month: month, Day: day}
}

// windowStart is the first session the views read: `date >= D - days`.
func windowStart(d civil.Date, days int) civil.Date {
	return d.AddDays(-days)
}

// lastOnOrBefore returns the newest point dated on or before target, with its
// index in pts (ascending by date), or false when none is.
func lastOnOrBefore(pts []pt, target civil.Date) (int, bool) {
	// Binary search for the first point after target, then step back one.
	lo, hi := 0, len(pts)
	for lo < hi {
		mid := (lo + hi) / 2
		if pts[mid].date.After(target) {
			hi = mid
		} else {
			lo = mid + 1
		}
	}
	if lo == 0 {
		return 0, false
	}
	return lo - 1, true
}

// calendarReturn is the views' ret_<N>m_pct for a window ending at asOf: the
// close against the last session on or before asOf minus N months, with that
// session no more than 10 days before the target (a gap is not a return). The
// close and date of the anchor session are returned too, for the RS figures.
func calendarReturn(pts []pt, asOf civil.Date, months, toleranceDays int, closeNow float64) (ret *float64, anchor civil.Date, anchorClose float64, ok bool) {
	bound := minusMonths(asOf, months)
	i, found := lastOnOrBefore(pts, bound)
	if !found {
		return nil, civil.Date{}, 0, false
	}
	anchor, anchorClose = pts[i].date, pts[i].close
	if anchorClose > 0 && !anchor.Before(bound.AddDays(-toleranceDays)) {
		r := (closeNow/anchorClose - 1) * 100
		return &r, anchor, anchorClose, true
	}
	return nil, anchor, anchorClose, true
}
