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

	// The session answers over [lo, hi] are precomputed once in New, as a prefix
	// count, so the hot reads are integer arithmetic instead of civil-date work.
	// ranged is false only for an empty calendar, which keeps the slow path.
	ranged bool
	loNum  int64 // day number of lo, the earliest index or ASIC date
	hiNum  int64 // day number of hi, the later of lastReport and newestIndex
	cum    []int // cum[i] counts the sessions among the days loNum .. loNum+i-1
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
	c.buildRange()
	return c
}

// buildRange precomputes the session answers over [lo, hi]. Every day in the
// range is answered by isSessionSlow, so inside the range the prefix counts are
// exact by construction. lo is the earliest index or ASIC date and hi the later
// of the newest ASIC report and the newest index bar: the switch in isSessionSlow
// reads only those maps up to hi, so no answer past hi is precomputed.
func (c *Calendar) buildRange() {
	if !c.hasReport && !c.hasIndex {
		return
	}
	var lo civil.Date
	first := true
	consider := func(d civil.Date) {
		if first || d.Before(lo) {
			lo, first = d, false
		}
	}
	for d := range c.index {
		consider(d)
	}
	for d := range c.asic {
		consider(d)
	}
	hi := lo
	if c.hasReport {
		hi = c.lastReport
	}
	if c.hasIndex && (!c.hasReport || c.newestIndex.After(hi)) {
		hi = c.newestIndex
	}
	c.loNum, c.hiNum = dayNum(lo), dayNum(hi)
	c.cum = make([]int, c.hiNum-c.loNum+2)
	for i := int64(0); i <= c.hiNum-c.loNum; i++ {
		c.cum[i+1] = c.cum[i]
		if c.isSessionSlow(civilFromDays(c.loNum + i)) {
			c.cum[i+1]++
		}
	}
	c.ranged = true
}

// Mismatches reports the disagreements found when the calendar was built.
func (c *Calendar) Mismatches() Mismatches { return c.mismatches }

// IsSession reports whether d is a trading session of this calendar.
func (c *Calendar) IsSession(d civil.Date) bool {
	return c.isSessionNum(dayNum(d))
}

// isSessionNum is IsSession for a day number.
func (c *Calendar) isSessionNum(n int64) bool {
	if c.ranged && n >= c.loNum && n <= c.hiNum {
		i := n - c.loNum
		return c.cum[i+1] != c.cum[i]
	}
	return c.isSessionSlow(civilFromDays(n))
}

// isSessionSlow is the session rule itself. Up to the newest ASIC report a
// session is a date in both the index and the ASIC data; past it, and up to the
// newest index bar, it is an index bar on a trading day; past both, the holiday
// table alone decides. It is the reference for the precomputed answers.
func (c *Calendar) isSessionSlow(d civil.Date) bool {
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
	n := dayNum(reportDate)
	sessions := 0
	for k := 0; k < maxLagDays; k++ {
		n++
		if c.isSessionNum(n) {
			sessions++
			if sessions == c.lag {
				return civilFromDays(n), true
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
//
// Inside [lo, hi] the count is the difference of two prefix counts. Before lo it
// is zero: in a non-empty calendar no day before lo is a session, because the
// first branch of isSessionSlow needs the day in both index and asic (and lo is
// the earliest date of either), and the other two branches need the day in the
// index. Past hi the days are answered one by one by isSessionSlow.
func (c *Calendar) SessionsBetween(from, to civil.Date) int {
	if !to.After(from) {
		return 0
	}
	a, b := dayNum(from)+1, dayNum(to)
	if !c.ranged {
		n := 0
		for dd := a; dd <= b; dd++ {
			if c.isSessionSlow(civilFromDays(dd)) {
				n++
			}
		}
		return n
	}
	n := 0
	if x, y := max(a, c.loNum), min(b, c.hiNum); x <= y {
		n += c.cum[y-c.loNum+1] - c.cum[x-c.loNum]
	}
	for dd := max(a, c.hiNum+1); dd <= b; dd++ {
		if c.isSessionSlow(civilFromDays(dd)) {
			n++
		}
	}
	return n
}

// dayNum is the number of days from 1970-01-01 to d (negative before it). It is
// the days-from-civil algorithm in integer arithmetic: unlike time.Time or
// civil.Date.AddDays it allocates nothing, which the backtest's session reads
// need.
func dayNum(d civil.Date) int64 {
	y := int64(d.Year)
	m := int64(d.Month)
	if m <= 2 {
		y--
	}
	var era int64
	if y >= 0 {
		era = y / 400
	} else {
		era = (y - 399) / 400
	}
	yoe := y - era*400
	mp := (m + 9) % 12
	doy := (153*mp+2)/5 + int64(d.Day) - 1
	doe := yoe*365 + yoe/4 - yoe/100 + doy
	return era*146097 + doe - 719468
}

// civilFromDays is the inverse of dayNum.
func civilFromDays(z int64) civil.Date {
	z += 719468
	var era int64
	if z >= 0 {
		era = z / 146097
	} else {
		era = (z - 146096) / 146097
	}
	doe := z - era*146097
	yoe := (doe - doe/1460 + doe/36524 - doe/146096) / 365
	y := yoe + era*400
	doy := doe - (365*yoe + yoe/4 - yoe/100)
	mp := (5*doy + 2) / 153
	day := doy - (153*mp+2)/5 + 1
	m := mp + 3
	if mp >= 10 {
		m = mp - 9
	}
	if m <= 2 {
		y++
	}
	return civil.Date{Year: int(y), Month: time.Month(m), Day: int(day)}
}

func tradingDay(d civil.Date) bool {
	return asxcalendar.IsTradingDay(time.Date(d.Year, d.Month, d.Day, 0, 0, 0, 0, time.UTC))
}
