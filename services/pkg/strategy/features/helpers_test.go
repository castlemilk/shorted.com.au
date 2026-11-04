package features

import (
	"testing"

	"cloud.google.com/go/civil"

	"github.com/castlemilk/shorted.com.au/services/pkg/strategy/calendar"
)

func mustDate(t *testing.T, s string) civil.Date {
	t.Helper()
	d, err := civil.ParseDate(s)
	if err != nil {
		t.Fatalf("ParseDate(%q): %v", s, err)
	}
	return d
}

// weekdaysFrom returns n weekday dates starting at first. The fixtures use
// only spans of 2026 with no ASX holiday in them, so a weekday is a session.
func weekdaysFrom(t *testing.T, first string, n int) []civil.Date {
	t.Helper()
	var out []civil.Date
	for d := mustDate(t, first); len(out) < n; d = d.AddDays(1) {
		if w := d.Weekday(); w == 0 || w == 6 {
			continue
		}
		out = append(out, d)
	}
	return out
}

// testCalendar treats every weekday from July to mid December 2026 as both an
// index bar and an ASIC report date, so the calendar's sessions are the weekdays.
func testCalendar(t *testing.T) *calendar.Calendar {
	t.Helper()
	days := weekdaysFrom(t, "2026-07-01", 120)
	return calendar.New(days, days, calendar.PublicationLagSessions)
}

// barsFrom returns n weekday bars starting at first, each closing at 100 on a
// volume of 1000. Tests change the closes or volumes they care about.
func barsFrom(t *testing.T, first string, n int) []Bar {
	t.Helper()
	days := weekdaysFrom(t, first, n)
	out := make([]Bar, n)
	for i, d := range days {
		out[i] = Bar{Date: d, Open: 100, High: 100, Low: 100, Close: 100, AdjClose: 100, Volume: 1000}
	}
	return out
}

func ptr(f float64) *float64 { return &f }

// row is one ASIC row for code on the report date.
func row(t *testing.T, code, date, product string, positions, issued float64, pct *float64) ASICRow {
	t.Helper()
	return ASICRow{
		Code:       code,
		ReportDate: mustDate(t, date),
		Product:    product,
		Positions:  positions,
		Issued:     issued,
		Percent:    pct,
	}
}

// replaceRow swaps the row with the same code and report date for next.
func replaceRow(t *testing.T, rows []ASICRow, next ASICRow) []ASICRow {
	t.Helper()
	out := make([]ASICRow, 0, len(rows))
	found := false
	for _, r := range rows {
		if r.Code == next.Code && r.ReportDate == next.ReportDate {
			out = append(out, next)
			found = true
			continue
		}
		out = append(out, r)
	}
	if !found {
		t.Fatalf("no row for %s on %s to replace", next.Code, next.ReportDate)
	}
	return out
}

// removeRow drops the row for code on date.
func removeRow(rows []ASICRow, code, date string) []ASICRow {
	var out []ASICRow
	for _, r := range rows {
		if r.Code == code && r.ReportDate.String() == date {
			continue
		}
		out = append(out, r)
	}
	return out
}

func intPtr(n int) *int { return &n }
