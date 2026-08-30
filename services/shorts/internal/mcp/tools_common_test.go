package mcp

import "testing"

// downsample kept both endpoints without checking whether the strided walk had
// already produced a full quota, so it could return max+1 — 201 points at a cap
// of 200. Both the output schema and the tool description promise "at most
// max", and a series one longer than advertised is a small lie in a document
// an agent reads as a contract.
//
// The boundary only appears when (len-1) is an exact multiple of the stride,
// which is why a 2,500-point fixture never caught it and a 400-point one does.
func TestDownsampleNeverExceedsItsCap(t *testing.T) {
	for _, n := range []int{0, 1, 199, 200, 201, 399, 400, 401, 2500} {
		in := make([]int, n)
		for i := range in {
			in[i] = i
		}

		got := downsample(in, 200)

		if len(got) > 200 {
			t.Errorf("downsample(%d items, 200) returned %d points — over the advertised cap", n, len(got))
		}
		if n == 0 {
			continue
		}
		// Both endpoints must survive: an agent reading a trend needs to know
		// where the series actually starts and ends.
		if got[0] != in[0] {
			t.Errorf("downsample(%d items) lost the first point", n)
		}
		if got[len(got)-1] != in[len(in)-1] {
			t.Errorf("downsample(%d items) lost the last point: got %d, want %d",
				n, got[len(got)-1], in[len(in)-1])
		}
	}
}

func TestDownsampleLeavesShortSeriesAlone(t *testing.T) {
	in := []int{1, 2, 3}
	got := downsample(in, 200)
	if len(got) != 3 {
		t.Fatalf("downsample of a short series returned %d points, want 3", len(got))
	}
}
