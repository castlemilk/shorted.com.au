package features

import (
	"math"
	"sort"

	"cloud.google.com/go/civil"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/calendar"
)

// Kinds of corporate-action suspect, in the order a bar takes them when more
// than one applies: a zero-volume artifact, then an up-jump with an integer
// ratio, then a corroborated share change.
const (
	CAZeroVolume   = "zero_volume"
	CAUpjump       = "upjump"
	CACorroborated = "corroborated"
)

// CASuspect is a bar whose price move may be an unadjusted share consolidation
// or split rather than a return. KnownAt is the first date the suspect may be
// used: the bar itself, or for a corroborated suspect the publication date of
// the report that corroborates it.
type CASuspect struct {
	Date    civil.Date
	KnownAt civil.Date
	Kind    string
}

const (
	// caMoveFactor is the price move that makes a bar a candidate: a factor of
	// 1.8 either way, in log terms.
	caMoveFactor = 1.8
	// caPriceTolerance is how far the price move may stray from the inverse of
	// the share change for corroboration: a factor of 1.25.
	caPriceTolerance = 1.25
	// caCorroborationSessions is the window, in sessions either side of the bar,
	// that the two reports bounding a share change must both fall in.
	caCorroborationSessions = 3
	// caUpjumpTolerance is how close an up-jump's ratio must sit to an integer.
	caUpjumpTolerance = 0.03
)

// CASuspects returns the corporate-action suspects in bars, which must be date
// ascending. bars is the code's stock_prices rows, unfiltered: a row whose close
// fails validPrice is dropped first, and the move is measured between the priced
// bars on either side of it, so a jump across an unpriced row is still seen.
// asic is the code's own ASIC rows in any order, and upjumpFrom is the first bar
// date after the last live re-sync (DataPolicy.ca_upjump_from).
//
// A bar with a move of at least 1.8 either way is a suspect when it has a
// zero-volume bar, or an up-jump at or after upjumpFrom whose ratio is an
// integer of at least 2 within 3%, or when two reports within three sessions
// either side of it bracket a share change of the same size whose inverse the
// price move matches within 1.25. Up-jumps need no corroboration: voiding a
// real gain is the conservative error, and a re-sync that left the history
// unadjusted produces exactly these jumps. Down-jumps need corroboration.
func CASuspects(bars []Bar, asic []ASICRow, cal *calendar.Calendar, upjumpFrom civil.Date) []CASuspect {
	rows := usableShareRows(asic)
	var out []CASuspect
	priced := make([]Bar, 0, len(bars))
	for _, b := range bars {
		if validPrice(b.Close) {
			priced = append(priced, b)
		}
	}
	for i := 1; i < len(priced); i++ {
		prev, cur := priced[i-1], priced[i]
		ratio := cur.Close / prev.Close
		logMove := math.Log(ratio)
		if math.IsNaN(logMove) || math.Abs(logMove) < math.Log(caMoveFactor) {
			continue
		}
		var s CASuspect
		switch {
		case cur.Volume == 0:
			s = CASuspect{Date: cur.Date, KnownAt: cur.Date, Kind: CAZeroVolume}
		case logMove > 0 && !cur.Date.Before(upjumpFrom) && integerRatio(ratio):
			s = CASuspect{Date: cur.Date, KnownAt: cur.Date, Kind: CAUpjump}
		default:
			known, ok := corroboratedAt(cur.Date, ratio, rows, cal)
			if !ok {
				continue
			}
			s = CASuspect{Date: cur.Date, KnownAt: known, Kind: CACorroborated}
		}
		out = append(out, s)
	}
	return out
}

// corroboratedAt finds a pair of consecutive reports, both within the window
// around t, whose share change has the size of the price move's inverse. The
// suspect is known once the later report of the pair is public.
func corroboratedAt(t civil.Date, ratio float64, rows []ASICRow, cal *calendar.Calendar) (civil.Date, bool) {
	for j := 0; j+1 < len(rows); j++ {
		before, after := rows[j], rows[j+1]
		if !withinSessions(before.ReportDate, t, cal) || !withinSessions(after.ReportDate, t, cal) {
			continue
		}
		share := after.Issued / before.Issued
		if math.Abs(math.Log(share)) < math.Log(caMoveFactor) {
			continue
		}
		if math.Abs(math.Log(ratio*share)) > math.Log(caPriceTolerance) {
			continue
		}
		known := t
		if published, ok := cal.PublishedOn(after.ReportDate); ok && published.After(t) {
			known = published
		}
		return known, true
	}
	return civil.Date{}, false
}

// withinSessions reports whether d lies within caCorroborationSessions sessions
// of t in either direction.
func withinSessions(d, t civil.Date, cal *calendar.Calendar) bool {
	if d.After(t) {
		return cal.SessionsBetween(t, d) <= caCorroborationSessions
	}
	return cal.SessionsBetween(d, t) <= caCorroborationSessions
}

// integerRatio reports whether a price ratio is within caUpjumpTolerance of an
// integer of at least 2.
func integerRatio(ratio float64) bool {
	n := math.Round(ratio)
	return n >= 2 && math.Abs(ratio/n-1) <= caUpjumpTolerance
}

// usableShareRows returns the rows with a positive share count, sorted by
// report date. A zero or missing count cannot anchor a share ratio.
func usableShareRows(asic []ASICRow) []ASICRow {
	var rows []ASICRow
	for _, r := range asic {
		if r.Issued > 0 && !math.IsNaN(r.Issued) {
			rows = append(rows, r)
		}
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].ReportDate.Before(rows[j].ReportDate) })
	return rows
}

// KnownBy returns the suspects whose KnownAt is on or before asOf: the ones a
// decision made at asOf may use.
func KnownBy(suspects []CASuspect, asOf civil.Date) []CASuspect {
	var out []CASuspect
	for _, s := range suspects {
		if !s.KnownAt.After(asOf) {
			out = append(out, s)
		}
	}
	return out
}
