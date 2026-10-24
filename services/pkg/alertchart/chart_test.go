package alertchart

import (
	"bytes"
	"errors"
	"fmt"
	"image/png"
	"math"
	"testing"
	"time"
)

func f64(v float64) *float64 { return &v }

// series builds n trading-day readings from start, rising from lo to hi. The
// dates skip weekends so the spacing matches real report dates.
func series(n int, start time.Time, lo, hi float64) []Point {
	out := make([]Point, 0, n)
	d := start
	for i := 0; i < n; i++ {
		for d.Weekday() == time.Saturday || d.Weekday() == time.Sunday {
			d = d.AddDate(0, 0, 1)
		}
		v := lo + (hi-lo)*float64(i)/float64(n-1)
		out = append(out, Point{Date: d.Format("2006-01-02"), Value: math.Round(v*100) / 100})
		d = d.AddDate(0, 0, 1)
	}
	return out
}

func glencore(n int) Spec {
	pts := series(n, time.Date(2026, 5, 1, 0, 0, 0, 0, time.UTC), 3, 12.15)
	last := pts[len(pts)-1].Date
	prev := pts[len(pts)-2].Date
	return Spec{Points: pts, Threshold: f64(10), ReportDate: last, ComparedTo: prev}
}

func TestRenderIsByteIdenticalAcrossRuns(t *testing.T) {
	spec := glencore(120)
	a, err := Render(spec)
	if err != nil {
		t.Fatal(err)
	}
	b, err := Render(spec)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(a, b) {
		t.Fatal("two renders of the same spec differ")
	}
}

func TestRenderDecodesAtTheCanvasSize(t *testing.T) {
	got, err := Render(glencore(120))
	if err != nil {
		t.Fatal(err)
	}
	img, err := png.Decode(bytes.NewReader(got))
	if err != nil {
		t.Fatalf("output is not a PNG: %v", err)
	}
	if b := img.Bounds(); b.Dx() != 1104 || b.Dy() != 440 {
		t.Fatalf("size = %dx%d, want 1104x440", b.Dx(), b.Dy())
	}
}

func TestRenderSizeStaysUnder80KBFor130Points(t *testing.T) {
	got, err := Render(glencore(130))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) >= 80*1024 {
		t.Fatalf("130-point chart is %d bytes, want under 80 KB", len(got))
	}
}

func TestRenderWithoutThresholdOrComparedPoint(t *testing.T) {
	spec := glencore(40)
	spec.Threshold = nil
	spec.ComparedTo = ""
	if _, err := Render(spec); err != nil {
		t.Fatalf("no threshold and no compared point must render: %v", err)
	}
	// A report date that is not in the series falls back to the last point.
	spec.ReportDate = "1999-01-01"
	if _, err := Render(spec); err != nil {
		t.Fatalf("an unknown report date must fall back, not fail: %v", err)
	}
}

func TestRenderEmptyAndShortSeriesReturnTheSentinel(t *testing.T) {
	for _, n := range []int{0, 1, 2} {
		pts := series(n, time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC), 1, 2)
		_, err := Render(Spec{Points: pts, ReportDate: "x"})
		if !errors.Is(err, ErrTooFewPoints) {
			t.Fatalf("%d points: err = %v, want ErrTooFewPoints", n, err)
		}
	}
}

func TestRenderAllZeroSeriesStillDraws(t *testing.T) {
	pts := []Point{{"2026-10-12", 0}, {"2026-10-13", 0}, {"2026-10-14", 0}}
	got, err := Render(Spec{Points: pts, ReportDate: "2026-10-14", ComparedTo: "2026-10-13"})
	if err != nil {
		t.Fatalf("a flat zero series must render: %v", err)
	}
	if _, err := png.Decode(bytes.NewReader(got)); err != nil {
		t.Fatal(err)
	}
}

func TestRenderRejectsABadDate(t *testing.T) {
	pts := series(5, time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC), 1, 2)
	pts[2].Date = "16/10/2026"
	if _, err := Render(Spec{Points: pts}); err == nil {
		t.Fatal("a malformed date must fail the render")
	}
}

// The axis picks a step from {1,2,2.5,5,10} times a power of ten, and the top is
// a whole number of steps at or above the padded maximum.
func TestNiceAxisGivesFourOrFiveIntervals(t *testing.T) {
	for _, maxVal := range []float64{0.4, 3.3, 9.7, 13.97, 27, 88, 140.2} {
		step, top := niceAxis(maxVal)
		if top < maxVal {
			t.Errorf("max %v: top %v is below the maximum", maxVal, top)
		}
		intervals := math.Round(top / step)
		if intervals < 3 || intervals > 6 {
			t.Errorf("max %v: %v intervals (step %v), want about four or five", maxVal, intervals, step)
		}
		ok := false
		for _, m := range niceMultiples {
			mag := math.Pow(10, math.Floor(math.Log10(step)))
			if math.Abs(step-mag*m) < 1e-9*step {
				ok = true
			}
		}
		if !ok {
			t.Errorf("max %v: step %v is not 1, 2, 2.5, 5 or 10 times a power of ten", maxVal, step)
		}
	}
}

// Every chart draws the same canvas, and the test for determinism above already
// covers the bytes. This keeps the threshold-off path from silently changing shape.
func TestThresholdChangesTheRender(t *testing.T) {
	with := glencore(60)
	without := glencore(60)
	without.Threshold = nil
	a, err := Render(with)
	if err != nil {
		t.Fatal(err)
	}
	b, err := Render(without)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(a, b) {
		t.Fatal("the alert level must change the image")
	}
}

func ExampleRender() {
	pts := []Point{{"2026-10-14", 6.5}, {"2026-10-15", 6.99}, {"2026-10-16", 12.15}}
	b, err := Render(Spec{Points: pts, Threshold: f64(10), ReportDate: "2026-10-16", ComparedTo: "2026-10-15"})
	fmt.Println(err, len(b) > 0)
	// Output: <nil> true
}
