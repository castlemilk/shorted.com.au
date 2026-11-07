package features

import (
	"math"
	"testing"
)

// The two products below feed comparisons (the liquidity threshold; the RS
// quartile and rs_leader), so their bits must not depend on the architecture.
// The compiler fuses an unrounded a*b+c into one FMA on arm64 but not on amd64,
// and the two results differ in the last bit for these inputs. The expected
// values are the separately rounded arithmetic, which is what amd64 produces and
// what PostgreSQL computes. The test fails on arm64 if a product loses its
// explicit float64 conversion.

// dvCloses and dvVolumes are the newest 20 sessions, rank 1 first, of a stock
// whose dollar volume is exact only with separate rounding.
var (
	dvCloses = []float64{21.700000000000003, 58.87, 89.31, 47.04, 37.35, 69.14, 3.5399999999999996, 88.69000000000001,
		58.03, 75.38000000000001, 53.36, 36.129999999999995, 65.15, 57.989999999999995, 22.020000000000003, 14.42,
		53.28, 45.089999999999996, 24.26, 17.110000000000003}
	dvVolumes = []float64{2.709973e+06, 7.938823e+06, 7.714372e+06, 7.490219e+06, 1.673887e+06, 6.982787e+06,
		6.645999e+06, 6.891706e+06, 1.803794e+06, 911068, 5.966284e+06, 1.731276e+06, 3.829553e+06, 482697, 729206,
		1.898485e+06, 118560, 6.779692e+06, 4.460809e+06, 8.04393e+06}
)

func TestDollarVolumeIsSeparatelyRounded(t *testing.T) {
	last := day(t, "2024-03-29")
	bars := series(last, 60, func(i int) Bar {
		rank := 60 - i // rank 1 is the newest bar
		if rank <= 20 {
			return flatBar(dvCloses[rank-1], dvVolumes[rank-1])
		}
		return flatBar(10, 1000)
	})
	got, ok := AsOf(bars, nil, last, v0FS1(t))
	if !ok || got.DollarVolume20d == nil {
		t.Fatalf("AsOf: ok=%v dollar volume %v", ok, got.DollarVolume20d)
	}
	sum := 0.0
	for rank := 1; rank <= 20; rank++ {
		sum = sum + float64(dvCloses[rank-1]*dvVolumes[rank-1])
	}
	want := sum / 20
	if *got.DollarVolume20d != want {
		t.Fatalf("dollar_volume_20d = %v, want the separately rounded %v", *got.DollarVolume20d, want)
	}
}

func TestRelativeStrengthIsSeparatelyRounded(t *testing.T) {
	// Variables, not constants: a constant expression is folded exactly, not in float64.
	var (
		stockReturn = 50.16 // ret_6m_pct
		xjoNow      = 333.68
		xjoThen     = 210.26
	)
	asOf := day(t, "2024-03-29")
	anchor := day(t, "2023-09-29")
	xjo := []IndexBar{{Date: anchor, Close: xjoThen}, {Date: asOf, Close: xjoNow}}
	got := relativeStrength(ptr(stockReturn), anchor, true, asOf, xjo, 7)
	if got == nil {
		t.Fatal("relativeStrength = nil with both index closes in tolerance")
	}
	want := stockReturn - float64((xjoNow/xjoThen-1)*100)
	if *got != want {
		t.Fatalf("rs = %v, want the separately rounded %v", *got, want)
	}
}

// TestSeparateRoundingIsNotTheFusedValue checks that the pinned dollar volume
// inputs are ones where a fused accumulation differs, so the pin above is not
// vacuous on any architecture.
func TestSeparateRoundingIsNotTheFusedValue(t *testing.T) {
	sum := 0.0
	fused := 0.0
	for i := range dvCloses {
		sum = sum + float64(dvCloses[i]*dvVolumes[i])
		fused = math.FMA(dvCloses[i], dvVolumes[i], fused)
	}
	if sum == fused {
		t.Fatal("the dollar volume pin no longer distinguishes fused from separately rounded arithmetic")
	}
}
