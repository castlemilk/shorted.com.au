package shorts

import (
	"testing"
	"time"

	stocksv1alpha1 "github.com/castlemilk/shorted.com.au/services/gen/proto/go/stocks/v1alpha1"
	"google.golang.org/protobuf/types/known/timestamppb"
)

func series(n int) []*stocksv1alpha1.TimeSeriesPoint {
	base := time.Date(2016, 1, 1, 0, 0, 0, 0, time.UTC)
	out := make([]*stocksv1alpha1.TimeSeriesPoint, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, &stocksv1alpha1.TimeSeriesPoint{
			Timestamp:     timestamppb.New(base.AddDate(0, 0, i)),
			ShortPosition: float64(i),
		})
	}
	return out
}

func TestThinTimeSeries(t *testing.T) {
	t.Run("keeps both endpoints", func(t *testing.T) {
		// The endpoints are what a reader anchors a trend on. An every-Nth
		// filter drops the last observation whenever the stride does not
		// divide evenly, which silently changes the story the series tells.
		for _, n := range []int{201, 500, 2500, 3897} {
			for _, max := range []int{2, 7, 200} {
				got := thinTimeSeries(series(n), max)
				if len(got) != max {
					t.Fatalf("n=%d max=%d: got %d points, want %d", n, max, len(got), max)
				}
				if got[0].ShortPosition != 0 {
					t.Errorf("n=%d max=%d: first point is %v, want the first observation", n, max, got[0].ShortPosition)
				}
				if want := float64(n - 1); got[len(got)-1].ShortPosition != want {
					t.Errorf("n=%d max=%d: last point is %v, want the final observation %v",
						n, max, got[len(got)-1].ShortPosition, want)
				}
			}
		}
	})

	t.Run("returns the series untouched when it already fits", func(t *testing.T) {
		in := series(50)
		got := thinTimeSeries(in, 200)
		if len(got) != 50 {
			t.Errorf("got %d points, want all 50 back", len(got))
		}
	})

	t.Run("a zero or negative cap means no thinning", func(t *testing.T) {
		in := series(500)
		for _, max := range []int{0, -1} {
			if got := thinTimeSeries(in, max); len(got) != 500 {
				t.Errorf("max=%d: got %d points, want no thinning", max, len(got))
			}
		}
	})

	t.Run("a cap of one keeps the most recent observation", func(t *testing.T) {
		got := thinTimeSeries(series(500), 1)
		if len(got) != 1 {
			t.Fatalf("got %d points, want 1", len(got))
		}
		if got[0].ShortPosition != 499 {
			t.Errorf("kept %v, want the latest observation", got[0].ShortPosition)
		}
	})

	t.Run("output is strictly ordered and never duplicates a point", func(t *testing.T) {
		got := thinTimeSeries(series(3897), 200)
		for i := 1; i < len(got); i++ {
			if got[i].ShortPosition <= got[i-1].ShortPosition {
				t.Fatalf("point %d (%v) does not advance past %d (%v)",
					i, got[i].ShortPosition, i-1, got[i-1].ShortPosition)
			}
		}
	})
}

func TestPeriodToTruncInterval(t *testing.T) {
	// Only the long windows are coarsened. Everything up to 2Y is already one
	// bucket per trading day, so bucketing there changes nothing — which is
	// why the default stayed safe to leave in place.
	daily := []string{"1D", "1W", "1M", "3M", "6M", "1Y", "2Y", "", "garbage"}
	for _, p := range daily {
		if got := periodToTruncInterval(p); got != "day" {
			t.Errorf("periodToTruncInterval(%q) = %q, want day", p, got)
		}
	}
	for _, p := range []string{"5Y", "10Y", "MAX", "max", "5y"} {
		if got := periodToTruncInterval(p); got != "week" {
			t.Errorf("periodToTruncInterval(%q) = %q, want week", p, got)
		}
	}
}
