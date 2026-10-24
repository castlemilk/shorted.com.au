package shorts

import (
	"strings"
	"testing"
)

// window builds a report window newest first from per-date readings.
func window(dates []string, readings map[string]map[string]float64, names map[string]string) AlertWindow {
	if names == nil {
		names = map[string]string{}
	}
	if readings == nil {
		readings = map[string]map[string]float64{}
	}
	return AlertWindow{Dates: dates, Readings: readings, Names: names}
}

func TestShortInterestAboveIsAnUpwardCrossingOnRoundedReadings(t *testing.T) {
	cases := []struct {
		name             string
		previous, latest float64
		threshold        float64
		want             bool
	}{
		{"crosses up", 4.2, 5.1, 5, true},
		{"landing exactly on the threshold counts", 4.9, 5, 5, true},
		{"already above at the previous report", 5.2, 5.4, 5, false},
		{"previous exactly on the threshold is not below it", 5, 5.4, 5, false},
		{"a fall through the threshold never fires", 5.4, 4.2, 5, false},
		{"previous rounds up to the threshold", 4.996, 5.4, 5, false},
		{"latest rounds up to the threshold", 4.9, 4.996, 5, true},
		{"rounding does not manufacture a crossing", 4.994, 4.994, 5, false},
		{"a latest reading that rounds to the threshold does cross", 4.994, 4.998, 5, true},
	}
	for _, c := range cases {
		if got := ShortInterestAboveCrossed(c.previous, c.latest, c.threshold); got != c.want {
			t.Errorf("%s: ShortInterestAboveCrossed(%v, %v, %v) = %v, want %v", c.name, c.previous, c.latest, c.threshold, got, c.want)
		}
	}
}

func TestFindReturnsTheMostRecentCrossingAgainstTheReportBeforeIt(t *testing.T) {
	w := window(
		[]string{"2026-10-22", "2026-10-21", "2026-10-20"},
		map[string]map[string]float64{
			"2026-10-22": {"ABC": 6.1, "XYZ": 2.0},
			"2026-10-21": {"ABC": 5.5, "XYZ": 2.0},
			"2026-10-20": {"ABC": 4.0, "XYZ": 2.0},
		},
		map[string]string{"ABC": "ABC Holdings"},
	)
	got, ok := w.FindShortInterestCrossing("ABC", 5)
	if !ok {
		t.Fatal("ABC crossed 5 on 2026-10-21 (4.0 -> 5.5 is one step earlier), expected a crossing")
	}
	// 2026-10-22 is 5.5 -> 6.1, already above: not a crossing. The most recent
	// crossing is 2026-10-21 (4.0 -> 5.5), compared with 2026-10-20.
	if got.ReportDate != "2026-10-21" || got.ComparedTo != "2026-10-20" || got.PreviousDate != "2026-10-20" {
		t.Fatalf("crossing = %+v", got)
	}
	if got.Previous != 4 || got.Latest != 5.5 || got.Name != "ABC Holdings" {
		t.Fatalf("crossing readings = %+v", got)
	}
}

func TestTheOldestDateIsNeverACandidate(t *testing.T) {
	// The newest date compares with the one before it, so it is evaluable. The
	// oldest date of the window has no earlier report in the window to compare
	// with, so the replay cannot evaluate it.
	w := window(
		[]string{"2026-10-22", "2026-10-21"},
		map[string]map[string]float64{
			"2026-10-22": {"ABC": 6.1},
			"2026-10-21": {"ABC": 4.0},
		},
		nil,
	)
	got, ok := w.FindShortInterestCrossing("ABC", 5)
	if !ok || got.ReportDate != "2026-10-22" || got.ComparedTo != "2026-10-21" {
		t.Fatalf("crossing on the newest date = %+v, %v", got, ok)
	}
	if _, err := w.CrossingOn("ABC", "2026-10-21", 5); err == nil || !strings.Contains(err.Error(), "no earlier report") {
		t.Fatalf("CrossingOn(oldest) = %v, want a no-earlier-report refusal", err)
	}
}

func TestPreviousReadingComesFromTheLookbackWhenTheComparedReportLacksTheCode(t *testing.T) {
	// ABC is missing from the compared report (2026-10-20), so its previous reading
	// is the one two reports back, which is what the evaluator reads.
	w := window(
		[]string{"2026-10-22", "2026-10-21", "2026-10-20", "2026-10-19"},
		map[string]map[string]float64{
			"2026-10-22": {"ABC": 5.4, "DEF": 1},
			"2026-10-21": {"DEF": 1},
			"2026-10-20": {"DEF": 1},
			"2026-10-19": {"ABC": 4.5, "DEF": 1},
		},
		nil,
	)
	got, ok := w.FindShortInterestCrossing("ABC", 5)
	if !ok {
		t.Fatal("expected a crossing via the lookback")
	}
	if got.ReportDate != "2026-10-22" || got.ComparedTo != "2026-10-21" || got.PreviousDate != "2026-10-19" || got.Previous != 4.5 {
		t.Fatalf("crossing = %+v", got)
	}
}

func TestAnIncompleteDayIsHeldNotEvaluated(t *testing.T) {
	// 2026-10-21 has fewer than half the rows of 2026-10-20, so planDaily holds it:
	// the crossing on it is not a candidate, and the search moves to an older date.
	w := window(
		[]string{"2026-10-22", "2026-10-21", "2026-10-20"},
		map[string]map[string]float64{
			"2026-10-22": {"ABC": 6, "A": 1, "B": 1, "C": 1},
			"2026-10-21": {"ABC": 5.5},
			"2026-10-20": {"ABC": 4, "A": 1, "B": 1, "C": 1},
		},
		nil,
	)
	if _, err := w.CrossingOn("ABC", "2026-10-21", 5); err == nil || !strings.Contains(err.Error(), "incomplete") {
		t.Fatalf("CrossingOn(incomplete) = %v, want an incomplete refusal", err)
	}
	if _, ok := w.FindShortInterestCrossing("ABC", 5); ok {
		t.Fatal("a crossing on a held day must not be returned")
	}
}

func TestCodeLessSearchPrefersTheMostShortedNewestReading(t *testing.T) {
	w := window(
		[]string{"2026-10-22", "2026-10-21"},
		map[string]map[string]float64{
			"2026-10-22": {"LOW": 5.2, "HIGH": 9.0, "NONE": 1.0},
			"2026-10-21": {"LOW": 4.0, "HIGH": 4.0, "NONE": 1.0},
		},
		nil,
	)
	got, ok := w.FindShortInterestCrossing("", 5)
	if !ok {
		t.Fatal("expected a crossing among the candidates")
	}
	if got.Code != "HIGH" || got.ReportDate != "2026-10-22" {
		// Both LOW and HIGH cross on the newest date's comparison, but HIGH has the
		// larger newest reading, so it leads the candidates.
		t.Fatalf("crossing = %+v", got)
	}
}

func TestCrossingOnRefusesDatesOutsideTheWindow(t *testing.T) {
	w := window([]string{"2026-10-22", "2026-10-21"}, map[string]map[string]float64{
		"2026-10-22": {"ABC": 6}, "2026-10-21": {"ABC": 4},
	}, nil)
	if _, err := w.CrossingOn("ABC", "2026-10-01", 5); err == nil || !strings.Contains(err.Error(), "not one of the last") {
		t.Fatalf("CrossingOn(outside) = %v", err)
	}
	c, err := w.CrossingOn("ABC", "2026-10-22", 5)
	if err != nil || c.Previous != 4 || c.Latest != 6 {
		t.Fatalf("CrossingOn(crossing) = %+v, %v", c, err)
	}
}
