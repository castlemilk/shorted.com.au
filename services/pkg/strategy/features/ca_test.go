package features

import (
	"testing"

	"cloud.google.com/go/civil"
)

// suspectsOf runs CASuspects over bars with the given rows for the code and the
// test calendar and the re-sync boundary of the live data.
func suspectsOf(t *testing.T, bars []Bar, rows []ASICRow) []CASuspect {
	t.Helper()
	return CASuspects(bars, rows, testCalendar(t), mustDate(t, "2026-09-29"))
}

// jumpAt returns bars from first with the close multiplied by ratio from index
// at onwards, so the bar at at moves by ratio against its predecessor.
func jumpAt(t *testing.T, first string, n, at int, ratio float64) []Bar {
	t.Helper()
	bars := barsFrom(t, first, n)
	for i := at; i < n; i++ {
		bars[i].Close *= ratio
		bars[i].AdjClose *= ratio
	}
	return bars
}

// TestCAGuardNeedsCorroboration: a large move is a suspect only with evidence
// the move is a share change: a zero-volume artifact, an up-jump at an integer
// ratio after the re-sync boundary, or a report pair that corroborates it. Real
// large moves without evidence stay in the history.
func TestCAGuardNeedsCorroboration(t *testing.T) {
	t.Run("uncorroborated up-jump before the boundary is kept", func(t *testing.T) {
		bars := jumpAt(t, "2026-09-01", 10, 3, 2.0)
		if got := suspectsOf(t, bars, nil); len(got) != 0 {
			t.Errorf("suspects = %+v, want none", got)
		}
	})
	t.Run("uncorroborated down-jump after the boundary is kept", func(t *testing.T) {
		bars := jumpAt(t, "2026-10-05", 10, 3, 0.5)
		if got := suspectsOf(t, bars, nil); len(got) != 0 {
			t.Errorf("suspects = %+v, want none", got)
		}
	})
	t.Run("uncorroborated move with no integer ratio is kept", func(t *testing.T) {
		bars := jumpAt(t, "2026-10-05", 10, 3, 1.85)
		if got := suspectsOf(t, bars, nil); len(got) != 0 {
			t.Errorf("suspects = %+v, want none", got)
		}
	})
	t.Run("a move under the threshold is never a suspect", func(t *testing.T) {
		bars := jumpAt(t, "2026-10-05", 10, 3, 1.5)
		bars[3].Volume = 0
		if got := suspectsOf(t, bars, nil); len(got) != 0 {
			t.Errorf("suspects = %+v, want none", got)
		}
	})
	t.Run("zero-volume artifact is known at its own bar", func(t *testing.T) {
		bars := jumpAt(t, "2026-10-05", 10, 3, 0.5)
		bars[3].Volume = 0
		got := suspectsOf(t, bars, nil)
		if len(got) != 1 || got[0].Kind != CAZeroVolume || got[0].KnownAt != bars[3].Date {
			t.Errorf("suspects = %+v, want one zero-volume suspect known on %s", got, bars[3].Date)
		}
	})
	t.Run("corroborated split is known when its later report is public", func(t *testing.T) {
		bars := jumpAt(t, "2026-10-05", 10, 3, 0.1)
		rows := []ASICRow{
			{Code: "ABC", ReportDate: bars[2].Date, Issued: 100_000_000},
			{Code: "ABC", ReportDate: bars[3].Date, Issued: 1_000_000_000},
		}
		got := suspectsOf(t, bars, rows)
		if len(got) != 1 || got[0].Kind != CACorroborated {
			t.Fatalf("suspects = %+v, want one corroborated suspect", got)
		}
		// The later report, dated bars[3], is public on the fourth session after
		// it, which is bars[7] in this run of weekdays.
		if got[0].KnownAt != bars[7].Date {
			t.Errorf("KnownAt = %s, want %s (the report's publication date)", got[0].KnownAt, bars[7].Date)
		}
	})
	t.Run("a share change the price does not mirror is not corroborated", func(t *testing.T) {
		bars := jumpAt(t, "2026-10-05", 10, 3, 0.5)
		rows := []ASICRow{
			{Code: "ABC", ReportDate: bars[2].Date, Issued: 100_000_000},
			{Code: "ABC", ReportDate: bars[3].Date, Issued: 1_000_000_000},
		}
		if got := suspectsOf(t, bars, rows); len(got) != 0 {
			t.Errorf("suspects = %+v, want none: 0.5 x 10 is not 1", got)
		}
	})
	t.Run("a report pair outside the window does not corroborate", func(t *testing.T) {
		bars := jumpAt(t, "2026-10-05", 14, 3, 0.1)
		rows := []ASICRow{
			{Code: "ABC", ReportDate: bars[9].Date, Issued: 100_000_000},
			{Code: "ABC", ReportDate: bars[10].Date, Issued: 1_000_000_000},
		}
		if got := suspectsOf(t, bars, rows); len(got) != 0 {
			t.Errorf("suspects = %+v, want none: the reports are seven sessions away", got)
		}
	})
}

// TestCAUpjumpRatios: an up-jump after the boundary is a suspect when its ratio
// is an integer of at least two within 3%. Down-jumps never are without
// corroboration.
func TestCAUpjumpRatios(t *testing.T) {
	tests := []struct {
		ratio float64
		want  bool
	}{
		{2.0, true},
		{2.02, true},
		{1.97, true},
		{3.0, true},
		{4.0, true},
		{1.93, false},
		{2.07, false},
		{2.9, false},
		{2.5, false},
		{1.8, false},
	}
	for _, tc := range tests {
		bars := jumpAt(t, "2026-10-05", 10, 3, tc.ratio)
		got := suspectsOf(t, bars, nil)
		if has := len(got) == 1 && got[0].Kind == CAUpjump; has != tc.want {
			t.Errorf("ratio %v: up-jump suspect = %v, want %v (suspects %+v)", tc.ratio, has, tc.want, got)
		}
	}
	bars := jumpAt(t, "2026-10-05", 10, 3, 0.5)
	if got := suspectsOf(t, bars, nil); len(got) != 0 {
		t.Errorf("down-jump 0.5 after the boundary: suspects %+v, want none", got)
	}
}

// TestCABasisChangeMakesDaysToCoverUnknown: a suspect dated after the report
// and known by the decision date makes the report's days to cover unknown,
// while the reading itself stays reported. Known only after the decision date,
// it does not.
func TestCABasisChangeMakesDaysToCoverUnknown(t *testing.T) {
	cal := testCalendar(t)
	_, rows := septemberReports(t)
	reports := NewReports(rows, nil)
	asOf := mustDate(t, "2026-10-06")
	bars := barsFrom(t, "2026-09-09", 21)

	known := []CASuspect{{Date: mustDate(t, "2026-10-01"), KnownAt: mustDate(t, "2026-10-02"), Kind: CACorroborated}}
	got := ShortReadingV1("ABC", asOf, cal, reports, bars, known, StaleAfterSessions)
	if got.Status != StatusReported {
		t.Fatalf("status = %q, want reported", got.Status)
	}
	if got.DaysToCover != nil || got.DaysToCoverReason != ReasonBasisChange {
		t.Errorf("days to cover = %v reason %q, want unknown for %s", got.DaysToCover, got.DaysToCoverReason, ReasonBasisChange)
	}

	later := []CASuspect{{Date: mustDate(t, "2026-10-01"), KnownAt: civil.Date{Year: 2026, Month: 10, Day: 7}, Kind: CACorroborated}}
	got = ShortReadingV1("ABC", asOf, cal, reports, bars, later, StaleAfterSessions)
	if got.DaysToCover == nil || *got.DaysToCover != 0.5 {
		t.Errorf("days to cover = %v (reason %q), want 0.5: 500 positions over a 1,000 mean", got.DaysToCover, got.DaysToCoverReason)
	}
}
