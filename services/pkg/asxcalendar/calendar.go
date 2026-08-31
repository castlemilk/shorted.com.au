// Package asxcalendar answers "was the market open?" and "when did an ASIC
// report become public?".
//
// ASIC publishes a short-position report for date D roughly four TRADING days
// later. Until now the API returned an observation dated D and said nothing
// about when it was knowable, so a backtest using the D value on D had four
// days of lookahead and nothing in the response revealed it. A caller could
// only apply a blunt calendar-month lag by hand.
package asxcalendar

import (
	"fmt"
	"time"
)

// PublicationLagTradingDays is ASIC's T+4. The product already states this to
// users — the MCP tool descriptions, the chat system prompt and the MCP
// resources all say "published with a T+4 business-day delay" — so this makes
// an existing published fact machine-readable rather than inventing an
// estimate.
const PublicationLagTradingDays = 4

// Holidays are ASX national trading holidays; weekends are handled separately.
//
// Duplicated from .github/workflows/shorts-data-freshness.mjs, which needs the
// same list in JavaScript. Duplication is a drift hazard, so
// TestHolidaysMatchTheFreshnessSentinel parses that file and fails when the
// two disagree — the tactic the quota contract test already uses to keep the
// pricing page honest against Go.
//
// Over-listing a day is the SAFE direction: an extra holiday pushes
// availability LATER, so a point-in-time query withholds an observation it
// could have shown rather than showing one that was not yet public.
// Under-listing creates lookahead, which is the bug this package prevents.
var Holidays = map[string]bool{
	// 2026
	"2026-01-01": true, // New Year's Day
	"2026-01-26": true, // Australia Day
	"2026-04-03": true, // Good Friday
	"2026-04-06": true, // Easter Monday
	"2026-04-27": true, // Anzac Day (25th falls on a Saturday)
	"2026-06-08": true, // King's Birthday
	"2026-12-25": true, // Christmas Day
	"2026-12-28": true, // Boxing Day (observed)
	// 2027
	"2027-01-01": true, // New Year's Day
	"2027-01-26": true, // Australia Day
	"2027-03-26": true, // Good Friday
	"2027-03-29": true, // Easter Monday
	"2027-04-26": true, // Anzac Day (observed)
	"2027-06-14": true, // King's Birthday
	"2027-12-27": true, // Christmas Day (observed)
	"2027-12-28": true, // Boxing Day (observed)
}

// HolidayCoverageEndYear is the last year Holidays is complete for.
const HolidayCoverageEndYear = 2027

// IsTradingDay reports whether the ASX was open on t.
func IsTradingDay(t time.Time) bool {
	switch t.Weekday() {
	case time.Saturday, time.Sunday:
		return false
	}
	return !Holidays[t.Format("2006-01-02")]
}

// AvailableFrom returns the date an observation reported for reportDate became
// public: PublicationLagTradingDays trading days after it.
//
// Beyond HolidayCoverageEndYear the table runs out, so a holiday inside the lag
// window counts as a trading day and the result lands up to a few days EARLY —
// the unsafe direction. HolidayCoverageIsCurrent exists so a test fails before
// that happens rather than after.
func AvailableFrom(reportDate time.Time) time.Time {
	d := reportDate
	for remaining := PublicationLagTradingDays; remaining > 0; {
		d = d.AddDate(0, 0, 1)
		if IsTradingDay(d) {
			remaining--
		}
	}
	return d
}

// WasKnownOn reports whether an observation reported for reportDate had been
// published by asOf. This is the predicate a point-in-time query filters on.
func WasKnownOn(reportDate, asOf time.Time) bool {
	return !AvailableFrom(reportDate).After(asOf)
}

// HolidayCoverageIsCurrent reports whether the holiday table still covers now,
// and why not when it does not.
func HolidayCoverageIsCurrent(now time.Time) (bool, string) {
	if now.Year() < HolidayCoverageEndYear {
		return true, ""
	}
	return false, fmt.Sprintf(
		"ASX holiday coverage ends %d but it is %d: extend asxcalendar.Holidays "+
			"and .github/workflows/shorts-data-freshness.mjs together, or publication "+
			"dates will be computed too early and reintroduce lookahead",
		HolidayCoverageEndYear, now.Year())
}
