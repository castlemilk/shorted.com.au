package asxcalendar

import (
	"os"
	"path/filepath"
	"regexp"
	"testing"
	"time"
)

func date(s string) time.Time {
	t, err := time.Parse("2006-01-02", s)
	if err != nil {
		panic(err)
	}
	return t
}

func TestIsTradingDay(t *testing.T) {
	tests := map[string]bool{
		"2026-08-31": true,  // Monday
		"2026-09-04": true,  // Friday
		"2026-08-29": false, // Saturday
		"2026-08-30": false, // Sunday
		"2026-04-03": false, // Good Friday
		"2026-04-06": false, // Easter Monday
		"2026-12-25": false, // Christmas Day
	}
	for day, want := range tests {
		if got := IsTradingDay(date(day)); got != want {
			t.Errorf("IsTradingDay(%s) = %v, want %v", day, got, want)
		}
	}
}

func TestAvailableFrom(t *testing.T) {
	tests := []struct {
		name   string
		report string
		want   string
	}{
		{
			// Mon 2026-08-03 + 4 trading days = Fri 2026-08-07.
			name: "a clean week", report: "2026-08-03", want: "2026-08-07",
		},
		{
			// Thu 2026-08-06 + 4 trading days crosses a weekend:
			// Fri 7, Mon 10, Tue 11, Wed 12.
			name: "crosses a weekend", report: "2026-08-06", want: "2026-08-12",
		},
		{
			// Mon 2026-03-30 + 4: Tue 31, Wed 1, Thu 2, (Fri 3 Good Friday),
			// (Mon 6 Easter Monday), Tue 7.
			name: "skips Easter", report: "2026-03-30", want: "2026-04-07",
		},
		{
			// A report dated on a weekend still just counts forward; ASIC dates
			// are trading days, but the function must not loop forever if one
			// is not.
			// Mon 31 (1), Tue 1 Sep (2), Wed 2 (3), Thu 3 (4).
			name: "report dated on a Saturday", report: "2026-08-29", want: "2026-09-03",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := AvailableFrom(date(tc.report)).Format("2006-01-02"); got != tc.want {
				t.Errorf("AvailableFrom(%s) = %s, want %s", tc.report, got, tc.want)
			}
		})
	}
}

// The lag must always be at least four calendar days and never land on a
// non-trading day — a publication date the market was closed on is wrong by
// construction.
func TestAvailableFromIsAlwaysALaterTradingDay(t *testing.T) {
	for d := date("2026-01-01"); d.Before(date("2027-12-01")); d = d.AddDate(0, 0, 1) {
		got := AvailableFrom(d)
		if !got.After(d) {
			t.Fatalf("AvailableFrom(%s) = %s, which is not after the report date",
				d.Format("2006-01-02"), got.Format("2006-01-02"))
		}
		if got.Sub(d) < 4*24*time.Hour {
			t.Errorf("AvailableFrom(%s) = %s, less than 4 calendar days later",
				d.Format("2006-01-02"), got.Format("2006-01-02"))
		}
		if !IsTradingDay(got) {
			t.Errorf("AvailableFrom(%s) = %s, which is not a trading day",
				d.Format("2006-01-02"), got.Format("2006-01-02"))
		}
	}
}

func TestWasKnownOn(t *testing.T) {
	report := date("2026-08-03") // available from 2026-08-07
	cases := map[string]bool{
		"2026-08-03": false, // the report date itself: four days of lookahead
		"2026-08-06": false, // the day before publication
		"2026-08-07": true,  // publication day
		"2026-08-10": true,  // after
	}
	for asOf, want := range cases {
		if got := WasKnownOn(report, date(asOf)); got != want {
			t.Errorf("WasKnownOn(2026-08-03, %s) = %v, want %v", asOf, got, want)
		}
	}
}

// The holiday list exists twice — here and in the freshness sentinel's
// JavaScript. Two hand-maintained calendars silently disagreeing is exactly
// how a publication date gets computed a day early, so this parses the other
// one rather than trusting them to be edited together.
func TestHolidaysMatchTheFreshnessSentinel(t *testing.T) {
	path := filepath.Join("..", "..", "..", ".github", "workflows", "shorts-data-freshness.mjs")
	src, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("cannot read the sentinel (%v); nothing to compare against", err)
	}

	block := regexp.MustCompile(`(?s)ASX_HOLIDAYS = new Set\(\[(.*?)\]\)`).FindSubmatch(src)
	if block == nil {
		t.Fatal("could not find ASX_HOLIDAYS in the sentinel — if it was renamed, update this test")
	}
	found := map[string]bool{}
	for _, m := range regexp.MustCompile(`"(\d{4}-\d{2}-\d{2})"`).FindAllSubmatch(block[1], -1) {
		found[string(m[1])] = true
	}
	if len(found) == 0 {
		t.Fatal("parsed zero holidays from the sentinel; the test would pass vacuously")
	}

	for day := range found {
		if !Holidays[day] {
			t.Errorf("%s is a holiday in the sentinel but not here — publication dates "+
				"would be computed a day early", day)
		}
	}
	for day := range Holidays {
		if !found[day] {
			t.Errorf("%s is a holiday here but not in the sentinel — the two calendars have drifted", day)
		}
	}
}

// Fails while there is still time to fix it, rather than after publication
// dates have quietly started landing early.
func TestHolidayCoverageHasNotRunOut(t *testing.T) {
	if ok, why := HolidayCoverageIsCurrent(time.Now()); !ok {
		t.Error(why)
	}
}
