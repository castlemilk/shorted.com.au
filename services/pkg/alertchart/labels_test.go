package alertchart

import (
	"fmt"
	"testing"
	"time"
)

// labelDates parses n trading-day dates from the series helper.
func labelDates(t *testing.T, n int) []time.Time {
	t.Helper()
	pts := series(n, time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC), 1, 2)
	out := make([]time.Time, len(pts))
	for i, p := range pts {
		d, err := time.Parse(dateLayout, p.Date)
		if err != nil {
			t.Fatal(err)
		}
		out[i] = d
	}
	return out
}

// assertClear fails when any two label boxes are closer than minLabelGap, and checks
// that the boxes are in ascending order, so the pairwise check is the adjacent one.
func assertClear(t *testing.T, labels []axisLabel) {
	t.Helper()
	for i := 1; i < len(labels); i++ {
		a, b := labels[i-1], labels[i]
		if b.box.x0 < a.box.x1 {
			t.Fatalf("%q and %q overlap: %.1f..%.1f and %.1f..%.1f", a.text, b.text, a.box.x0, a.box.x1, b.box.x0, b.box.x1)
		}
		if gap := b.box.x0 - a.box.x1; gap < minLabelGap {
			t.Fatalf("%q and %q are %.1fpx apart, want at least %d", a.text, b.text, gap, minLabelGap)
		}
	}
}

// Every short history from two to nineteen readings lays its labels out with no
// overlap, keeps the first and the last reading, and names each label with its day.
func TestShortHistoryLabelsNeverOverlap(t *testing.T) {
	faces, err := loadFaces()
	if err != nil {
		t.Fatal(err)
	}
	for n := 2; n <= 19; n++ {
		t.Run(fmt.Sprintf("n=%d", n), func(t *testing.T) {
			dates := labelDates(t, n)
			ax := axis{top: 10, n: n, short: true}
			labels := axisLabels(dates, true, ax, faces.axis)
			assertClear(t, labels)
			if labels[0].text != dates[0].Format("2 Jan") {
				t.Fatalf("the first reading must be labelled, got %q", labels[0].text)
			}
			if got := labels[len(labels)-1].text; got != dates[n-1].Format("2 Jan") {
				t.Fatalf("the last reading must be labelled, got %q", got)
			}
		})
	}
}

// The layout drops intermediate labels and never the ends. For eleven and fourteen
// readings, the cases the review rendered, the labels now stay apart.
func TestElevenAndFourteenReadingsLabelCleanly(t *testing.T) {
	faces, err := loadFaces()
	if err != nil {
		t.Fatal(err)
	}
	for _, n := range []int{11, 14} {
		dates := labelDates(t, n)
		labels := axisLabels(dates, true, axis{top: 10, n: n, short: true}, faces.axis)
		assertClear(t, labels)
		if len(labels) < 3 {
			t.Fatalf("n=%d: %d labels, want the ends and at least one between", n, len(labels))
		}
	}
}

// A long history labels its month boundaries, and adjacent labels keep the same gap.
func TestLongHistoryMonthLabelsKeepTheGap(t *testing.T) {
	faces, err := loadFaces()
	if err != nil {
		t.Fatal(err)
	}
	dates := labelDates(t, 130)
	labels := axisLabels(dates, false, axis{top: 10, n: 130}, faces.axis)
	assertClear(t, labels)
	if len(labels) < 4 {
		t.Fatalf("a six-month history needs several month labels, got %d", len(labels))
	}
	for _, l := range labels {
		if len(l.text) != 3 {
			t.Fatalf("a long history labels months only, got %q", l.text)
		}
	}
}

// The selection itself: when the ends cannot both fit, intermediate labels go first,
// and the first label is never dropped.
func TestSelectLabelsDropsIntermediatesBeforeEnds(t *testing.T) {
	mk := func(x float64) axisLabel {
		return axisLabel{text: "x", x: x, box: box{x0: x - 50, x1: x + 50}}
	}
	cands := []axisLabel{mk(100), mk(200), mk(300), mk(400), mk(430)}
	got := selectLabels(cands, true)
	assertClear(t, got)
	if got[0].x != 100 {
		t.Fatalf("the first label was dropped: %+v", got)
	}
	if got[len(got)-1].x != 430 {
		t.Fatalf("the last label must be kept when it fits: %+v", got)
	}
}
