package features

import (
	"encoding/json"
	"math"
	"testing"

	"cloud.google.com/go/civil"
)

// septemberReports returns the 22 weekdays of September 2026 with two ASIC rows
// on each: OTH, which every test leaves alone, and the code under test, ABC,
// reporting 5% on every date. Tests overwrite the rows they vary.
func septemberReports(t *testing.T) (dates []civil.Date, rows []ASICRow) {
	t.Helper()
	dates = weekdaysFrom(t, "2026-09-01", 22)
	for _, d := range dates {
		rows = append(rows,
			row(t, "OTH", d.String(), "OTHER GROUP ORDINARY", 1000, 10_000_000, ptr(1)),
			row(t, "ABC", d.String(), "ABC GROUP ORDINARY", 500, 10_000_000, ptr(5)),
		)
	}
	return dates, rows
}

// TestAbsentFromCompleteReportFails: a code missing from the newest usable
// report, which is complete, reads absent. That is a failing reading for the
// short rules, distinct from unknown, so the status must say absent and carry
// the report's dates.
func TestAbsentFromCompleteReportFails(t *testing.T) {
	cal := testCalendar(t)
	_, rows := septemberReports(t)
	rows = append(rows, row(t, "GHOST", "2026-09-29", "GHOST GROUP ORDINARY", 900, 10_000_000, ptr(9)))
	reports := NewReports(rows, nil)

	asOf := mustDate(t, "2026-10-06") // 30 September is public from 6 October
	got := ShortReadingV1("GHOST", asOf, cal, reports, nil, nil, StaleAfterSessions)
	if got.Status != StatusAbsent {
		t.Fatalf("status = %q, want %q (the newest complete report omits the code)", got.Status, StatusAbsent)
	}
	if got.ReportDate == nil || *got.ReportDate != mustDate(t, "2026-09-30") {
		t.Errorf("report date = %v, want 2026-09-30", got.ReportDate)
	}
	if got.Pct != nil || got.Positions != nil {
		t.Errorf("absent reading carries a value: pct=%v positions=%v", got.Pct, got.Positions)
	}
	if got.AvailableDate == nil || *got.AvailableDate != asOf {
		t.Errorf("available date = %v, want 2026-10-06", got.AvailableDate)
	}
}

// TestIncompleteNewestReportFallsBack: the newest usable report is partial, so
// the reading falls back to the report before it. A partial report must never
// supply a figure, even one the code really has in it.
func TestIncompleteNewestReportFallsBack(t *testing.T) {
	cal := testCalendar(t)
	asOf := mustDate(t, "2026-10-06")

	t.Run("recorded file rows", func(t *testing.T) {
		_, rows := septemberReports(t)
		// Replace the 30th's code row with a 9% figure, then record that the file
		// had ten codes and only two reached shorts.
		rows = replaceRow(t, rows, row(t, "ABC", "2026-09-30", "ABC GROUP ORDINARY", 900, 10_000_000, ptr(9)))
		ingests := []ReportIngest{{ReportDate: mustDate(t, "2026-09-30"), FileRows: intPtr(10), LoadedRows: 2}}
		reports := NewReports(rows, ingests)

		got := ShortReadingV1("ABC", asOf, cal, reports, nil, nil, StaleAfterSessions)
		assertFallbackToSeptember29(t, got)
	})

	t.Run("no recorded file rows, previous report has more rows", func(t *testing.T) {
		_, rows := septemberReports(t)
		// The 29th carries three rows. The 30th keeps only the code's own row, so
		// 2 * 1 < 3 and the half rule marks it partial.
		rows = removeRow(rows, "OTH", "2026-09-30")
		rows = append(rows, row(t, "XTR", "2026-09-29", "XTRA GROUP ORDINARY", 1, 10_000_000, ptr(1)))
		rows = replaceRow(t, rows, row(t, "ABC", "2026-09-30", "ABC GROUP ORDINARY", 900, 10_000_000, ptr(9)))
		reports := NewReports(rows, nil)

		got := ShortReadingV1("ABC", asOf, cal, reports, nil, nil, StaleAfterSessions)
		assertFallbackToSeptember29(t, got)
	})
}

// A NULL percentage is not a figure, so rows without one must not make a
// partial report complete: the alerts job counts only the finite rows.
func TestNullPercentRowsDoNotCompleteAReport(t *testing.T) {
	cal := testCalendar(t)
	asOf := mustDate(t, "2026-10-06")
	_, rows := septemberReports(t)
	rows = append(rows, row(t, "XTR", "2026-09-29", "XTRA GROUP ORDINARY", 1, 10_000_000, ptr(1)))
	rows = removeRow(rows, "OTH", "2026-09-30")
	rows = replaceRow(t, rows, row(t, "ABC", "2026-09-30", "ABC GROUP ORDINARY", 900, 10_000_000, ptr(9)))
	for _, code := range []string{"N1", "N2", "N3"} {
		rows = append(rows, row(t, code, "2026-09-30", code+" GROUP ORDINARY", 0, 10_000_000, nil))
	}
	reports := NewReports(rows, nil)

	got := ShortReadingV1("ABC", asOf, cal, reports, nil, nil, StaleAfterSessions)
	assertFallbackToSeptember29(t, got)
}

func assertFallbackToSeptember29(t *testing.T, got ShortReading) {
	t.Helper()
	if got.Status != StatusReported {
		t.Fatalf("status = %q, want %q", got.Status, StatusReported)
	}
	if got.ReportDate == nil || *got.ReportDate != mustDate(t, "2026-09-29") {
		t.Errorf("report date = %v, want the 29th, the newest complete report", got.ReportDate)
	}
	if got.Pct == nil || *got.Pct != 5 {
		t.Errorf("pct = %v, want 5 from the 29th; the partial 30th must not supply a figure", got.Pct)
	}
}

func TestShortReadingV1Statuses(t *testing.T) {
	cal := testCalendar(t)
	asOf := mustDate(t, "2026-10-06")

	t.Run("zero is a real zero", func(t *testing.T) {
		_, rows := septemberReports(t)
		rows = replaceRow(t, rows, row(t, "ABC", "2026-09-30", "ABC GROUP ORDINARY", 0, 10_000_000, ptr(0)))
		got := ShortReadingV1("ABC", asOf, cal, NewReports(rows, nil), nil, nil, StaleAfterSessions)
		if got.Status != StatusZero || got.Pct == nil || *got.Pct != 0 {
			t.Errorf("status = %q pct = %v, want zero with pct 0", got.Status, got.Pct)
		}
	})

	t.Run("a NULL percentage is unavailable, not zero", func(t *testing.T) {
		_, rows := septemberReports(t)
		rows = replaceRow(t, rows, row(t, "ABC", "2026-09-30", "ABC GROUP ORDINARY", 500, 10_000_000, nil))
		got := ShortReadingV1("ABC", asOf, cal, NewReports(rows, nil), nil, nil, StaleAfterSessions)
		if got.Status != StatusUnavailable || got.Reason != ReasonASICValueMissing {
			t.Errorf("status = %q reason = %q, want unavailable with %s", got.Status, got.Reason, ReasonASICValueMissing)
		}
		if got.Pct != nil {
			t.Errorf("unavailable reading carries pct %v", *got.Pct)
		}
	})

	t.Run("no complete report at all is stale without dates", func(t *testing.T) {
		rows := []ASICRow{
			row(t, "ABC", "2026-09-01", "ABC GROUP ORDINARY", 500, 10_000_000, ptr(5)),
		}
		// The file recorded ten codes and only one reached shorts: partial.
		ingests := []ReportIngest{{ReportDate: mustDate(t, "2026-09-01"), FileRows: intPtr(10), LoadedRows: 1}}
		got := ShortReadingV1("ABC", mustDate(t, "2026-09-25"), cal, NewReports(rows, ingests), nil, nil, StaleAfterSessions)
		if got.Status != StatusStale || got.Reason != ReasonASICReportStale {
			t.Errorf("status = %q reason = %q, want stale", got.Status, got.Reason)
		}
		if got.ReportDate != nil || got.Pct != nil || got.InReport != nil {
			t.Errorf("stale reading with no report names one: %+v", got)
		}
	})

	// The newest complete report is 17 sessions old at 25 September: stale, but
	// its dates and whether the code is in it still come through, so a listed
	// code keeps its universe membership with its short rules unknown.
	t.Run("an old complete report is stale with its dates", func(t *testing.T) {
		rows := []ASICRow{
			row(t, "ABC", "2026-09-01", "ABC GROUP ORDINARY", 500, 10_000_000, ptr(5)),
			row(t, "OTH", "2026-09-01", "OTHER GROUP ORDINARY", 1000, 10_000_000, ptr(1)),
		}
		reports := NewReports(rows, nil)
		asOf := mustDate(t, "2026-09-25")
		got := ShortReadingV1("ABC", asOf, cal, reports, nil, nil, StaleAfterSessions)
		if got.Status != StatusStale || got.Reason != ReasonASICReportStale {
			t.Errorf("status = %q reason = %q, want stale", got.Status, got.Reason)
		}
		if got.ReportDate == nil || *got.ReportDate != mustDate(t, "2026-09-01") {
			t.Errorf("report date = %v, want 2026-09-01", got.ReportDate)
		}
		if got.AvailableDate == nil || *got.AvailableDate != mustDate(t, "2026-09-07") {
			t.Errorf("available date = %v, want 2026-09-07", got.AvailableDate)
		}
		if got.InReport == nil || !*got.InReport {
			t.Errorf("in report = %v, want true: ABC is in the 1 September report", got.InReport)
		}
		if got.Pct != nil || got.Positions != nil || got.DaysToCover != nil {
			t.Errorf("stale reading carries a figure: %+v", got)
		}

		got = ShortReadingV1("GONE", asOf, cal, reports, nil, nil, StaleAfterSessions)
		if got.InReport == nil || *got.InReport {
			t.Errorf("GONE in report = %v, want false: the old report omits it", got.InReport)
		}
	})
}

// TestShortReadingV0Filters: sf0 is the latest row with a positive percentage
// that passes the v0 instrument filters, with no age limit. Each row here fails
// one filter except the one dated 3 August.
func TestShortReadingV0Filters(t *testing.T) {
	cal := testCalendar(t)
	rows := []ASICRow{
		row(t, "XYZ", "2026-08-03", "XYZ GROUP ORDINARY", 2_000, 100_000_000, ptr(5)),
		row(t, "XYZ", "2026-08-10", "XYZ GROUP ORDINARY", 0, 100_000_000, ptr(0)),
		row(t, "XYZ", "2026-08-17", "XYZ ETF UNITS", 3_000, 100_000_000, ptr(7)),
		row(t, "XYZ", "2026-08-24", "XYZ 4.5% NOTE", 4_000, 100_000_000, ptr(9)),
		row(t, "XYZ", "2026-08-31", "XYZ GROUP ORDINARY", 5_000, 1_000, ptr(11)),
		// A deferred settlement line that looks ordinary, dated after the 3rd.
		row(t, "XYZ", "2026-08-07", "XYZ DEFERRED SETTLEMENT", 6_000, 100_000_000, ptr(6)),
		// A five-character code, which is a secondary line whatever its name.
		row(t, "XYZAB", "2026-08-03", "XYZAB GROUP ORDINARY", 2_000, 100_000_000, ptr(5)),
	}
	reports := NewReports(rows, nil)

	t.Run("latest filtered row, no age limit", func(t *testing.T) {
		got := ShortReadingV0("XYZ", mustDate(t, "2026-12-18"), cal, reports, nil)
		if got.Status != StatusReported || got.ReportDate == nil || *got.ReportDate != mustDate(t, "2026-08-03") {
			t.Fatalf("got %+v, want the 3 August ordinary row", got)
		}
		if got.Pct == nil || *got.Pct != 5 || got.Positions == nil || *got.Positions != 2_000 {
			t.Errorf("pct/positions = %v/%v, want 5/2000", got.Pct, got.Positions)
		}
	})

	t.Run("nothing on or before the decision date", func(t *testing.T) {
		got := ShortReadingV0("XYZ", mustDate(t, "2026-07-31"), cal, reports, nil)
		if got.Status != StatusNone {
			t.Errorf("status = %q, want %q", got.Status, StatusNone)
		}
	})

	t.Run("a five-character code has no ordinary row", func(t *testing.T) {
		got := ShortReadingV0("XYZAB", mustDate(t, "2026-12-18"), cal, reports, nil)
		if got.Status != StatusNone {
			t.Errorf("status = %q, want %q: the code is longer than four characters", got.Status, StatusNone)
		}
	})
}

// TestNonFiniteValuesAreNotReadings: a NULL-like or infinite percentage or
// positions is not a figure. The reading must say unavailable (sf1) or skip the
// row (sf0), and whatever it returns must encode as JSON, because the snapshot
// stores it that way and one unencodable value would fail the whole write.
func TestNonFiniteValuesAreNotReadings(t *testing.T) {
	cal := testCalendar(t)
	asOf := mustDate(t, "2026-10-06")
	tests := []struct {
		name      string
		positions float64
		pct       float64
	}{
		{"+Inf percentage", 500, math.Inf(1)},
		{"-Inf percentage", 500, math.Inf(-1)},
		{"NaN percentage", 500, math.NaN()},
		{"+Inf positions", math.Inf(1), 5},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, rows := septemberReports(t)
			rows = replaceRow(t, rows, row(t, "ABC", "2026-09-30", "ABC GROUP ORDINARY", tc.positions, 10_000_000, ptr(tc.pct)))
			reports := NewReports(rows, nil)

			v1 := ShortReadingV1("ABC", asOf, cal, reports, nil, nil, StaleAfterSessions)
			if v1.Status != StatusUnavailable || v1.Reason != ReasonASICValueMissing {
				t.Errorf("sf1 status = %q reason = %q, want unavailable", v1.Status, v1.Reason)
			}
			if _, err := json.Marshal(v1); err != nil {
				t.Errorf("sf1 reading does not encode: %v", err)
			}

			// sf0 skips the 30th and reads the 29th, a finite 5%.
			v0 := ShortReadingV0("ABC", asOf, cal, reports, nil)
			if v0.Status != StatusReported || v0.ReportDate == nil || *v0.ReportDate != mustDate(t, "2026-09-29") {
				t.Errorf("sf0 = %+v, want the 29th", v0)
			}
			if _, err := json.Marshal(v0); err != nil {
				t.Errorf("sf0 reading does not encode: %v", err)
			}
		})
	}
}

// TestStaleBoundary: the newest complete report is eight sessions old on 11
// September and nine on the 14th. Eight is current, nine is stale.
func TestStaleBoundary(t *testing.T) {
	cal := testCalendar(t)
	rows := []ASICRow{
		row(t, "ABC", "2026-09-01", "ABC GROUP ORDINARY", 500, 10_000_000, ptr(5)),
		row(t, "OTH", "2026-09-01", "OTHER GROUP ORDINARY", 1000, 10_000_000, ptr(1)),
	}
	reports := NewReports(rows, nil)
	if got := cal.SessionsBetween(mustDate(t, "2026-09-01"), mustDate(t, "2026-09-11")); got != 8 {
		t.Fatalf("SessionsBetween(1 Sep, 11 Sep) = %d, want 8", got)
	}

	current := ShortReadingV1("ABC", mustDate(t, "2026-09-11"), cal, reports, nil, nil, StaleAfterSessions)
	if current.Status != StatusReported {
		t.Errorf("eight sessions old: status = %q, want reported", current.Status)
	}
	stale := ShortReadingV1("ABC", mustDate(t, "2026-09-14"), cal, reports, nil, nil, StaleAfterSessions)
	if stale.Status != StatusStale {
		t.Errorf("nine sessions old: status = %q, want stale", stale.Status)
	}
}
