// Package calendar derives the trading sessions the strategy pipeline reads its
// short-position data against, and the date each ASIC report became public.
//
// The sessions come from the data itself, not from a holiday table alone. A
// date is a session when the index bars and the ASIC short-position reports
// both carry it, up to the newest ASIC report. Intersecting the two sources is
// the safe direction: a spurious index bar, or an ASIC report dated on a day
// the market was shut, can only make a report look public later than it was,
// never earlier. A missing session has the same effect in the other direction:
// it delays availability by a session, which withholds a figure and never shows
// one early.
//
// The index dates must be the exchange's session dates. Stored history dated
// in UTC is one day early under daylight saving, which drops the Fridays; the
// calendar then delays availability, but the stored dates should be fixed at
// their source (see TestShiftedIndexDatesOnlyDelay).
//
// Past the newest ASIC report the holiday table decides, and past the newest
// index bar the table alone does. The table is asxcalendar's, which is complete
// for 2026 and 2027; the holiday coverage guard in that package covers later
// years.
package calendar

import (
	"time"

	"cloud.google.com/go/civil"

	"github.com/castlemilk/shorted.com.au/services/pkg/asxcalendar"
)

// PublicationLagSessions is the v1 publication lag, in sessions of this
// calendar: a report for date R is public from the fourth session after R. It
// is the value the v1 policy carries; the lag is a parameter of New, so a run
// with another lag (a sensitivity run) reads its own availability dates.
const PublicationLagSessions = 4

// maxLagDays bounds the walk to a publication date. Four sessions never span
// more than a long holiday weekend, so a walk past this many calendar days can
// only mean a calendar with no sessions in it.
const maxLagDays = 60

// Mismatches counts disagreements between the index bars and the ASIC reports.
// They are diagnostics: the calendar already resolves each one toward a later
// availability date.
type Mismatches struct {
	// ASICWithoutIndex counts ASIC report dates on or before the newest report
	// that no index bar carries.
	ASICWithoutIndex int
	// IndexWithoutASIC counts index bar dates from the oldest ASIC report up to
	// the newest that no report carries. Dates before ASIC's history starts are
	// not disagreements.
	IndexWithoutASIC int
}

// Calendar answers which dates are sessions and when a report became public.
// It is immutable after New and safe for concurrent reads.
type Calendar struct {
	index       map[civil.Date]bool
	asic        map[civil.Date]bool
	hasReport   bool
	firstReport civil.Date // oldest ASIC report date
	lastReport  civil.Date // newest ASIC report date
	hasIndex    bool
	newestIndex civil.Date // newest index bar date
	lag         int        // publication lag in sessions
	mismatches  Mismatches
}

// New builds the calendar from the index bar dates (XJO), the ASIC report dates
// and the publication lag in sessions (the policy's publication_lag_sessions).
// A lag of zero makes a report public on its own date. Duplicate and unordered
// input is accepted. It panics on a negative lag, which no policy can set.
func New(indexDates, asicReportDates []civil.Date, lagSessions int) *Calendar {
	if lagSessions < 0 {
		panic("calendar: negative publication lag")
	}
	c := &Calendar{
		index: make(map[civil.Date]bool, len(indexDates)),
		asic:  make(map[civil.Date]bool, len(asicReportDates)),
		lag:   lagSessions,
	}
	for _, d := range indexDates {
		c.index[d] = true
		if !c.hasIndex || d.After(c.newestIndex) {
			c.newestIndex, c.hasIndex = d, true
		}
	}
	for _, d := range asicReportDates {
		c.asic[d] = true
		if !c.hasReport || d.After(c.lastReport) {
			c.lastReport = d
		}
		if !c.hasReport || d.Before(c.firstReport) {
			c.firstReport = d
		}
		c.hasReport = true
	}
	if c.hasReport {
		for d := range c.asic {
			if !d.After(c.lastReport) && !c.index[d] {
				c.mismatches.ASICWithoutIndex++
			}
		}
		for d := range c.index {
			if !d.Before(c.firstReport) && d.Before(c.lastReport) && !c.asic[d] {
				c.mismatches.IndexWithoutASIC++
			}
		}
	}
	return c
}

// Mismatches reports the disagreements found when the calendar was built.
func (c *Calendar) Mismatches() Mismatches { return c.mismatches }

// IsSession reports whether d is a trading session of this calendar.
func (c *Calendar) IsSession(d civil.Date) bool {
	switch {
	case c.hasReport && !d.After(c.lastReport):
		return c.index[d] && c.asic[d]
	case c.hasIndex && !d.After(c.newestIndex):
		return c.index[d] && tradingDay(d)
	default:
		return tradingDay(d)
	}
}

// PublishedOn returns the date a report for reportDate became public: the
// lag-th session strictly after it (the report's own date for a lag of zero).
// ok is false only when no session falls within maxLagDays, which a calendar
// built from real data never produces.
func (c *Calendar) PublishedOn(reportDate civil.Date) (published civil.Date, ok bool) {
	if c.lag == 0 {
		return reportDate, true
	}
	d := reportDate
	sessions := 0
	for n := 0; n < maxLagDays; n++ {
		d = d.AddDays(1)
		if c.IsSession(d) {
			sessions++
			if sessions == c.lag {
				return d, true
			}
		}
	}
	return civil.Date{}, false
}

// Usable reports whether a report for reportDate is public at the close of
// decisionDate, the condition the pipeline reads a report under.
func (c *Calendar) Usable(reportDate, decisionDate civil.Date) bool {
	p, ok := c.PublishedOn(reportDate)
	return ok && !p.After(decisionDate)
}

// SessionsBetween counts the sessions s with from < s <= to. It is the age of
// a report at a decision date: zero on the report's own date, one on the next
// session, and so on. A to on or before from counts zero.
func (c *Calendar) SessionsBetween(from, to civil.Date) int {
	n := 0
	for d := from.AddDays(1); !d.After(to); d = d.AddDays(1) {
		if c.IsSession(d) {
			n++
		}
	}
	return n
}

func tradingDay(d civil.Date) bool {
	return asxcalendar.IsTradingDay(time.Date(d.Year, d.Month, d.Day, 0, 0, 0, 0, time.UTC))
}
