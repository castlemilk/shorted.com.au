package shorts

import "testing"

// Asking for "10Y" against a series holding two years returned the two years
// and said nothing, so a caller reasonably believed they had ten — and a
// risk-adjusted number computed over the wrong span is wrong in a way nothing
// in the response reveals (#572).
//
// Truncation is judged against the SERIES' coverage, not against the rows
// returned: such a request gets every session the series has, so comparing
// returned to requested rows would call it complete. That is the case most
// worth flagging.
func TestIsTruncated(t *testing.T) {
	const earliest, latest = "2019-04-29", "2026-09-01"

	tests := []struct {
		name             string
		from, to         string
		earliest, latest string
		want             bool
	}{
		{"window inside coverage", "2020-01-01", "2021-01-01", earliest, latest, false},
		{"window exactly at the bounds", earliest, latest, earliest, latest, false},

		// XJT begins 2019-04-29 upstream. No backfill moves that date, so a
		// caller asking for 2010 must be told, every time.
		{"starts before coverage", "2010-01-01", "2021-01-01", earliest, latest, true},
		{"ends after coverage", "2020-01-01", "2030-01-01", earliest, latest, true},
		{"straddles both ends", "2010-01-01", "2030-01-01", earliest, latest, true},
		{"one day before the start", "2019-04-28", "2020-01-01", earliest, latest, true},

		// An open-ended request asked for "whatever exists" and got it.
		{"no window given", "", "", earliest, latest, false},
		{"only a start, inside", "2020-01-01", "", earliest, latest, false},
		{"only a start, before", "2010-01-01", "", earliest, latest, true},
		{"only an end, after", "", "2030-01-01", earliest, latest, true},

		// An empty series already signals itself; saying it twice adds nothing.
		{"series holds nothing", "2010-01-01", "2020-01-01", "", "", false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := isTruncated(tc.from, tc.to, tc.earliest, tc.latest); got != tc.want {
				t.Errorf("isTruncated(%q, %q, %q, %q) = %v, want %v",
					tc.from, tc.to, tc.earliest, tc.latest, got, tc.want)
			}
		})
	}
}

// A period shorthand has to become a concrete date, or "10Y" against a
// two-year series leaves requested_from empty and the truncation is invisible
// — which is the exact shape of the original report.
func TestPeriodStartDate(t *testing.T) {
	const latest = "2026-09-01"

	tests := map[string]string{
		"1D":  "2026-08-31",
		"1W":  "2026-08-25",
		"1M":  "2026-08-01",
		"3M":  "2026-06-01",
		"6M":  "2026-03-01",
		"1Y":  "2025-09-01",
		"2Y":  "2024-09-01",
		"5Y":  "2021-09-01",
		"10Y": "2016-09-01",
		"10y": "2016-09-01", // case-insensitive, as the rest of the API is
	}
	for period, want := range tests {
		if got := periodStartDate(period, latest); got != want {
			t.Errorf("periodStartDate(%q, %q) = %q, want %q", period, latest, got, want)
		}
	}

	t.Run("MAX cannot fall short of itself", func(t *testing.T) {
		if got := periodStartDate("MAX", latest); got != "" {
			t.Errorf("periodStartDate(MAX) = %q, want empty", got)
		}
	})
	t.Run("an unknown period resolves to nothing rather than a wrong date", func(t *testing.T) {
		if got := periodStartDate("7Y", latest); got != "" {
			t.Errorf("periodStartDate(7Y) = %q, want empty", got)
		}
	})
	t.Run("an empty series yields no start date", func(t *testing.T) {
		if got := periodStartDate("10Y", ""); got != "" {
			t.Errorf("periodStartDate with no latest = %q, want empty", got)
		}
	})
}

// The reported case, end to end at the unit level: 10Y against a series that
// starts in 2019 must come back marked truncated.
func TestTenYearRequestOnAShortSeriesIsMarkedTruncated(t *testing.T) {
	const earliest, latest = "2019-04-29", "2026-09-01"
	from := periodStartDate("10Y", latest)
	if from == "" {
		t.Fatal("10Y must resolve to a concrete start date")
	}
	if !isTruncated(from, latest, earliest, latest) {
		t.Errorf("10Y (from %s) against a series starting %s must be truncated", from, earliest)
	}
}
