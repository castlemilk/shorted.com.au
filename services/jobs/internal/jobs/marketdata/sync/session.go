package sync

import (
	"fmt"
	"time"
	_ "time/tzdata" // the jobs image is distroless; embed the zone session dates depend on
)

// sydney is the ASX's zone. A session's date is its date there.
var sydney = func() *time.Location {
	loc, err := time.LoadLocation("Australia/Sydney")
	if err != nil {
		panic(fmt.Sprintf("load Australia/Sydney: %v", err)) // unreachable with time/tzdata embedded
	}
	return loc
}()

// sessionClosedHour is the Sydney hour from which a weekday's session counts as
// closed. Continuous trading ends at 16:00 and the closing auction by about
// 16:12; the hour after gives the provider time to publish the final bar.
const sessionClosedHour = 17

// maxClosedWeekdays is the most weekdays in a row the ASX closes for: Christmas
// and Boxing Day make two, and Easter makes three when Anzac Day's day in lieu
// lands on the Tuesday (Good Friday, Easter Monday, Tuesday: 2011). A window
// with more weekdays than this held a session.
const maxClosedWeekdays = 3

// lastClosedSession is the most recent weekday whose session had closed at now,
// as a midnight-UTC date (the form stock_prices dates scan into). It knows
// nothing of public holidays: a window that ends on one just fetches nothing
// for that day.
func lastClosedSession(now time.Time) time.Time {
	t := now.In(sydney)
	d := time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
	if t.Hour() < sessionClosedHour {
		d = d.AddDate(0, 0, -1)
	}
	for d.Weekday() == time.Saturday || d.Weekday() == time.Sunday {
		d = d.AddDate(0, 0, -1)
	}
	return d
}

// weekdaysIn counts the Monday-to-Friday dates in [from, to].
func weekdaysIn(from, to time.Time) int {
	n := 0
	for d := from; !d.After(to); d = d.AddDate(0, 0, 1) {
		if d.Weekday() != time.Saturday && d.Weekday() != time.Sunday {
			n++
		}
	}
	return n
}

// utcDate truncates t to its UTC calendar date.
func utcDate(t time.Time) time.Time {
	t = t.UTC()
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
}
