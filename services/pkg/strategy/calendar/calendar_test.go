package calendar

import (
	"testing"
	"time"

	"cloud.google.com/go/civil"

	"github.com/castlemilk/shorted.com.au/services/pkg/asxcalendar"
)

func mustDate(t *testing.T, s string) civil.Date {
	t.Helper()
	d, err := civil.ParseDate(s)
	if err != nil {
		t.Fatalf("ParseDate(%q): %v", s, err)
	}
	return d
}

// weekdays returns every Monday to Friday from first to last inclusive, minus
// the skipped dates. It stands in for a session list that a real feed would
// carry, so each test states exactly which dates are missing.
func weekdays(t *testing.T, first, last string, skip ...string) []civil.Date {
	t.Helper()
	skipped := map[civil.Date]bool{}
	for _, s := range skip {
		skipped[mustDate(t, s)] = true
	}
	var out []civil.Date
	for d, end := mustDate(t, first), mustDate(t, last); !d.After(end); d = d.AddDays(1) {
		if d.Weekday() == 0 || d.Weekday() == 6 || skipped[d] {
			continue
		}
		out = append(out, d)
	}
	return out
}

func without(dates []civil.Date, drop ...civil.Date) []civil.Date {
	gone := map[civil.Date]bool{}
	for _, d := range drop {
		gone[d] = true
	}
	var out []civil.Date
	for _, d := range dates {
		if !gone[d] {
			out = append(out, d)
		}
	}
	return out
}

// TestPublishedOnUsesDataCalendar checks the publication date against the
// sessions the data shows, not against the holiday table. In April 2019 Good
// Friday (19th) and Easter Monday (22nd) closed the market, and asxcalendar has
// no 2019 holidays, so its own answer is one session early.
func TestPublishedOnUsesDataCalendar(t *testing.T) {
	const (
		report = "2019-04-16"
		want   = "2019-04-24"
	)
	closed := []string{"2019-04-19", "2019-04-22", "2019-04-25"}
	sessions := weekdays(t, "2019-04-01", "2019-04-30", closed...)
	c := New(sessions, sessions)

	got, ok := c.PublishedOn(mustDate(t, report))
	if !ok {
		t.Fatal("PublishedOn found no publication date")
	}
	if got != mustDate(t, want) {
		t.Errorf("PublishedOn(%s) = %s, want %s", report, got, want)
	}

	naive := asxcalendar.AvailableFrom(time.Date(2019, time.April, 16, 0, 0, 0, 0, time.UTC))
	if naive.Format("2006-01-02") != "2019-04-22" {
		t.Fatalf("asxcalendar.AvailableFrom(%s) = %s; the comparison assumes 2019-04-22", report, naive.Format("2006-01-02"))
	}
	if got.String() == naive.Format("2006-01-02") {
		t.Error("the data calendar must not reproduce the holiday-table answer for 2019")
	}
}

// TestSpuriousIndexBarDoesNotMakeAvailabilityEarly puts an index bar on a day
// with no ASIC report (27 December 2022, when the market was shut). Counting it
// as a session would make the report for the 21st public on the 28th; the
// intersection leaves it out, so the 29th stands.
func TestSpuriousIndexBarDoesNotMakeAvailabilityEarly(t *testing.T) {
	asic := weekdays(t, "2022-12-19", "2022-12-30", "2022-12-26", "2022-12-27")
	// Index bars carry every weekday but the 26th, so the 27th is the spurious bar.
	index := weekdays(t, "2022-12-19", "2022-12-30", "2022-12-26")
	c := New(index, asic)

	got, ok := c.PublishedOn(mustDate(t, "2022-12-21"))
	if !ok {
		t.Fatal("PublishedOn found no publication date")
	}
	if got != mustDate(t, "2022-12-29") {
		t.Errorf("PublishedOn(2022-12-21) = %s, want 2022-12-29: the spurious 27 December bar made it early", got)
	}
	if c.IsSession(mustDate(t, "2022-12-27")) {
		t.Error("27 December with no ASIC report must not be a session")
	}
}

// TestMissingSessionOnlyDelays drops one real session from the index bars.
// Availability moves later by exactly the missing session; it never moves
// earlier, and the gap is counted as a mismatch.
func TestMissingSessionOnlyDelays(t *testing.T) {
	asic := weekdays(t, "2026-02-23", "2026-03-20")
	full := New(asic, asic)
	gappy := New(without(asic, mustDate(t, "2026-03-04")), asic)

	report := mustDate(t, "2026-03-02")
	before, ok := full.PublishedOn(report)
	if !ok {
		t.Fatal("full calendar: no publication date")
	}
	after, ok := gappy.PublishedOn(report)
	if !ok {
		t.Fatal("gappy calendar: no publication date")
	}
	if before != mustDate(t, "2026-03-06") {
		t.Errorf("full PublishedOn(2026-03-02) = %s, want 2026-03-06", before)
	}
	if after != mustDate(t, "2026-03-09") {
		t.Errorf("gappy PublishedOn(2026-03-02) = %s, want 2026-03-09", after)
	}
	if after.Before(before) {
		t.Errorf("a missing session moved availability earlier: %s < %s", after, before)
	}
	if got := gappy.Mismatches().ASICWithoutIndex; got != 1 {
		t.Errorf("ASICWithoutIndex = %d, want 1", got)
	}
	if got := full.Mismatches(); got != (Mismatches{}) {
		t.Errorf("a complete calendar reports mismatches: %+v", got)
	}
}

func TestUsableAtTheDecisionClose(t *testing.T) {
	asic := weekdays(t, "2026-02-23", "2026-03-20")
	c := New(asic, asic)
	report := mustDate(t, "2026-03-02")
	if c.Usable(report, mustDate(t, "2026-03-05")) {
		t.Error("report usable before its fourth session")
	}
	if !c.Usable(report, mustDate(t, "2026-03-06")) {
		t.Error("report not usable on its publication session")
	}
}

func TestSessionsBetweenCountsSessionsAfterFrom(t *testing.T) {
	asic := weekdays(t, "2026-02-23", "2026-03-20")
	c := New(asic, asic)
	cases := []struct {
		from, to string
		want     int
	}{
		{"2026-03-02", "2026-03-02", 0},
		{"2026-03-02", "2026-03-03", 1},
		{"2026-03-02", "2026-03-06", 4},
		{"2026-03-06", "2026-03-02", 0},
	}
	for _, tc := range cases {
		if got := c.SessionsBetween(mustDate(t, tc.from), mustDate(t, tc.to)); got != tc.want {
			t.Errorf("SessionsBetween(%s, %s) = %d, want %d", tc.from, tc.to, got, tc.want)
		}
	}
}

func TestPastTheNewestDataUsesTheHolidayTable(t *testing.T) {
	// The newest report is 2 March 2026, the newest index bar is the 3rd. From
	// the 4th on only the holiday table decides, so Good Friday 2026 (3 April)
	// is skipped and Easter Monday (6 April) too.
	asic := weekdays(t, "2026-02-23", "2026-03-02")
	index := weekdays(t, "2026-02-23", "2026-03-03")
	c := New(index, asic)
	got, ok := c.PublishedOn(mustDate(t, "2026-03-31"))
	if !ok {
		t.Fatal("no publication date")
	}
	if got != mustDate(t, "2026-04-08") {
		t.Errorf("PublishedOn(2026-03-31) = %s, want 2026-04-08 (Good Friday and Easter Monday skipped)", got)
	}
}
