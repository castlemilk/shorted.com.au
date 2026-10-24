package shorts

import (
	"strings"
	"testing"
	"time"
)

// window builds a report window newest first from per-date readings. It is padded to
// AlertWindowDates with older dates that hold no readings, as a real window is full,
// so the margin rule sees the same shape the smoke test does. The readings are used
// exactly as given: no filler code, so a test controls every count.
func window(dates []string, readings map[string]map[string]float64, names map[string]string) AlertWindow {
	if names == nil {
		names = map[string]string{}
	}
	if readings == nil {
		readings = map[string]map[string]float64{}
	}
	all := append([]string(nil), dates...)
	last, _ := time.Parse("2006-01-02", dates[len(dates)-1])
	for d := last.AddDate(0, 0, -1); len(all) < AlertWindowDates; d = d.AddDate(0, 0, -1) {
		all = append(all, d.Format("2006-01-02"))
	}
	return AlertWindow{Dates: all, Readings: readings, Names: names}
}

// dates returns n consecutive report dates, newest first, from 2026-10-22.
func dates(n int) []string {
	start, _ := time.Parse("2006-01-02", "2026-10-22")
	out := make([]string, n)
	for i := range out {
		out[i] = start.AddDate(0, 0, -i).Format("2006-01-02")
	}
	return out
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
	d := dates(3)
	w := window(d, map[string]map[string]float64{
		d[0]: {"ABC": 6.1, "XYZ": 2.0},
		d[1]: {"ABC": 5.5, "XYZ": 2.0},
		d[2]: {"ABC": 4.0, "XYZ": 2.0},
	}, map[string]string{"ABC": "ABC Holdings"})
	got, ok := w.FindShortInterestCrossing("ABC", 5)
	if !ok {
		t.Fatal("expected a crossing")
	}
	// d[0] is 5.5 -> 6.1, already above: not a crossing. The most recent is d[1]
	// (4.0 -> 5.5), compared with d[2].
	if got.ReportDate != d[1] || got.ComparedTo != d[2] || got.PreviousDate != d[2] {
		t.Fatalf("crossing = %+v", got)
	}
	if got.Previous != 4 || got.Latest != 5.5 || got.Name != "ABC Holdings" {
		t.Fatalf("crossing readings = %+v", got)
	}
}

// The margin: a date 3 positions from the oldest end (index 17 of 20) is refused,
// and index 16 is still offered. Mutants that move the margin to 2 or 4 fail here.
func TestTheOldestEndOfTheWindowIsRefusedWithAMargin(t *testing.T) {
	d := dates(AlertWindowDates)
	readings := map[string]map[string]float64{}
	put := func(i int, code string, v float64) {
		if readings[d[i]] == nil {
			readings[d[i]] = map[string]float64{}
		}
		readings[d[i]][code] = v
	}
	// A crossing at index 17 only (compared with index 18).
	put(17, "ABC", 5.5)
	put(18, "ABC", 4.0)
	w := window(d, readings, nil)
	if _, ok := w.FindShortInterestCrossing("ABC", 5); ok {
		t.Fatal("a date 3 from the oldest end must not be offered")
	}
	_, err := w.CrossingOn("ABC", d[17], 5)
	if err == nil || !strings.Contains(err.Error(), "among the 3 oldest report dates") {
		t.Fatalf("CrossingOn(index 17) = %v, want the oldest-end refusal", err)
	}

	// The same crossing at index 16 is offered.
	readings = map[string]map[string]float64{d[16]: {"ABC": 5.5, "F": 1}, d[17]: {"ABC": 4.0, "F": 1}}
	w = window(d, readings, nil)
	got, ok := w.FindShortInterestCrossing("ABC", 5)
	if !ok || got.ReportDate != d[16] {
		t.Fatalf("crossing at index 16 = %+v, %v; want it offered", got, ok)
	}
}

// The lookback: the previous reading may come from up to five dates after the
// compared date (index 1..5 for a date at index 0). A reading at index 5 is used; one
// at index 6 is not.
func TestPreviousReadingLookbackIsFiveDates(t *testing.T) {
	d := dates(7)
	// Within the lookback: ABC only at index 0 (5.5) and index 5 (4.0).
	r := map[string]map[string]float64{d[0]: {"ABC": 5.5, "X": 1}, d[1]: {"X": 1}, d[5]: {"ABC": 4.0, "X": 1}}
	got, ok := window(d, r, nil).FindShortInterestCrossing("ABC", 5)
	if !ok || got.ReportDate != d[0] || got.PreviousDate != d[5] || got.Previous != 4 {
		t.Fatalf("lookback depth 5: crossing = %+v, %v; want previous from %s", got, ok, d[5])
	}
	// Beyond it: ABC only at index 6, which the lookback from index 1 does not reach.
	r = map[string]map[string]float64{d[0]: {"ABC": 5.5, "X": 1}, d[1]: {"X": 1}, d[6]: {"ABC": 4.0, "X": 1}}
	if _, ok := window(d, r, nil).FindShortInterestCrossing("ABC", 5); ok {
		t.Fatal("lookback depth 6 must not be used")
	}
}

// The completeness boundary: a date with exactly half the rows of the report before
// it is complete (2*2 >= 4); one with fewer is not (2*1 < 4).
func TestAnIncompleteDayIsSkippedBySmokeTest(t *testing.T) {
	d := dates(2)
	full := map[string]map[string]float64{
		d[0]: {"ABC": 6, "X": 1},
		d[1]: {"ABC": 4, "X": 1, "Y": 1, "Z": 1},
	}
	got, ok := window(d, full, nil).FindShortInterestCrossing("ABC", 5)
	if !ok || got.ReportDate != d[0] {
		t.Fatalf("exactly half the rows is complete: crossing = %+v, %v", got, ok)
	}

	short := map[string]map[string]float64{
		d[0]: {"ABC": 6},
		d[1]: {"ABC": 4, "X": 1, "Y": 1, "Z": 1},
	}
	w := window(d, short, nil)
	if _, ok := w.FindShortInterestCrossing("ABC", 5); ok {
		t.Fatal("a half-written day must not be offered")
	}
	_, err := w.CrossingOn("ABC", d[0], 5)
	if err == nil || !strings.Contains(err.Error(), "skips incomplete dates") {
		t.Fatalf("CrossingOn(incomplete) = %v, want the skip refusal", err)
	}
}

// The code-less candidate filter uses the newest reading rounded to two places, the
// same rule as the crossing. 4.996 rounds to 5.00 and is a candidate; 4.994 does not.
func TestCodeLessCandidateUsesTheRoundedNewestReading(t *testing.T) {
	d := dates(2)
	up := map[string]map[string]float64{d[0]: {"ABC": 4.996}, d[1]: {"ABC": 4.0}}
	got, ok := window(d, up, nil).FindShortInterestCrossing("", 5)
	if !ok || got.Code != "ABC" {
		t.Fatalf("4.996 rounds to 5.00 and must be a candidate: %+v, %v", got, ok)
	}
	down := map[string]map[string]float64{d[0]: {"ABC": 4.994}, d[1]: {"ABC": 4.0}}
	if _, ok := window(d, down, nil).FindShortInterestCrossing("", 5); ok {
		t.Fatal("4.994 rounds to 4.99 and must not be a candidate")
	}
}

func TestCodeLessSearchPrefersTheMostShortedNewestReading(t *testing.T) {
	d := dates(2)
	w := window(d, map[string]map[string]float64{
		d[0]: {"LOW": 5.2, "HIGH": 9.0, "NONE": 1.0},
		d[1]: {"LOW": 4.0, "HIGH": 4.0, "NONE": 1.0},
	}, nil)
	got, ok := w.FindShortInterestCrossing("", 5)
	if !ok || got.Code != "HIGH" || got.ReportDate != d[0] {
		t.Fatalf("crossing = %+v, %v; want HIGH on %s", got, ok, d[0])
	}
}

// The window's newest date is a real, replayable date and its reading is present.
func TestTheWindowIncludesTheNewestDate(t *testing.T) {
	d := dates(2)
	w := window(d, map[string]map[string]float64{d[0]: {"ABC": 6}, d[1]: {"ABC": 4}}, nil)
	if w.Dates[0] != d[0] || w.Readings[d[0]]["ABC"] != 6 {
		t.Fatalf("newest date %s missing from the window", d[0])
	}
	if !w.replayable(0) {
		t.Fatal("the newest date must be replayable")
	}
}

func TestCrossingOnRefusesDatesOutsideTheWindow(t *testing.T) {
	d := dates(2)
	w := window(d, map[string]map[string]float64{d[0]: {"ABC": 6}, d[1]: {"ABC": 4}}, nil)
	if _, err := w.CrossingOn("ABC", "2026-10-01", 5); err == nil || !strings.Contains(err.Error(), "not one of the last") {
		t.Fatalf("CrossingOn(outside) = %v", err)
	}
	c, err := w.CrossingOn("ABC", d[0], 5)
	if err != nil || c.Previous != 4 || c.Latest != 6 {
		t.Fatalf("CrossingOn(crossing) = %+v, %v", c, err)
	}
	if _, err := w.CrossingOn("ABC", d[0], 9); err == nil || !strings.Contains(err.Error(), "did not cross") {
		t.Fatalf("CrossingOn(no crossing at 9) = %v, want the did-not-cross refusal", err)
	}
}
