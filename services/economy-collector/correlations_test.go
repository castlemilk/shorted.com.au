package main

import (
	"math"
	"testing"
	"time"
)

func correlationMonthly(values []float64, start time.Time) []correlationObservation {
	observations := make([]correlationObservation, len(values))
	for i, value := range values {
		observations[i] = correlationObservation{
			Period: start.AddDate(0, i, 0),
			Value:  value,
		}
	}
	return observations
}

func correlationQuarterly(values []float64, start time.Time) []correlationObservation {
	observations := make([]correlationObservation, len(values))
	for i, value := range values {
		observations[i] = correlationObservation{
			Period: start.AddDate(0, i*3, 0),
			Value:  value,
		}
	}
	return observations
}

func TestRollingPearsonMatchesTypeScriptGoldenVector(t *testing.T) {
	start := time.Date(2023, 1, 1, 0, 0, 0, 0, time.UTC)
	base := correlationMonthly(
		[]float64{3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5, 8, 9, 7, 9},
		start,
	)
	overlay := correlationQuarterly([]float64{2, 7, 1, 8, 2}, start)

	r, n, lastPeriod, ok := rollingPearson(base, overlay, 12)
	if !ok {
		t.Fatal("rollingPearson returned undefined, want a coefficient")
	}
	if n != 12 {
		t.Fatalf("n = %d, want 12", n)
	}
	if got, want := lastPeriod.Format("2006-01-02"), "2024-03-01"; got != want {
		t.Fatalf("lastPeriod = %s, want %s", got, want)
	}

	// Golden value reproduced from web/src/@/lib/economy/correlation.ts:
	// quarterly y expands to [2,2,2,7,7,7,1,1,1,8,8,8,2,2,2].
	// The latest 12 pairs use:
	//   x=[1,5,9,2,6,5,3,5,8,9,7,9], mean=5.75, Σdx²=84.25
	//   y=[7,7,7,1,1,1,8,8,8,2,2,2], mean=4.5,  Σdy²=111
	//   Σ(dx*dy)=-14.5
	// so r=-14.5/sqrt(84.25*111)=-0.14994139880598317.
	const want = -0.14994139880598317
	if math.Abs(r-want) > 1e-15 {
		t.Fatalf("r = %.17g, want TS golden %.17g", r, want)
	}
}

func TestAlignCorrelationMonthlyDoesNotFillMissingQuarter(t *testing.T) {
	start := time.Date(2023, 1, 1, 0, 0, 0, 0, time.UTC)
	base := correlationMonthly([]float64{1, 2, 3, 4, 5, 6, 7, 8, 9}, start)
	overlay := []correlationObservation{
		{Period: start, Value: 100},
		{Period: start.AddDate(0, 6, 0), Value: 300},
	}

	aligned := alignCorrelationMonthly(base, overlay)
	wantMonths := []string{"2023-01", "2023-02", "2023-03", "2023-07", "2023-08", "2023-09"}
	wantY := []float64{100, 100, 100, 300, 300, 300}
	if len(aligned) != len(wantMonths) {
		t.Fatalf("len(aligned) = %d, want %d: %#v", len(aligned), len(wantMonths), aligned)
	}
	for i := range aligned {
		if aligned[i].Month != wantMonths[i] || aligned[i].Y != wantY[i] {
			t.Errorf("aligned[%d] = %#v, want month=%s y=%v", i, aligned[i], wantMonths[i], wantY[i])
		}
	}
}

func TestComputeCorrelationRowsSelectsRegionAndNationalMonthlyQuarterlyOverlays(t *testing.T) {
	start := time.Date(2023, 1, 1, 0, 0, 0, 0, time.UTC)
	values := []float64{1, 4, 2, 8, 5, 7, 3, 9, 6, 10, 8, 11}
	series := []correlationSeries{
		{
			Key: "markets.short_interest_wavg.wa", Topic: "markets",
			RegionCode: "wa", RegionType: "state", Frequency: "monthly",
			Observations: correlationMonthly(values, start),
		},
		{
			Key: "spending.household.total.wa.seasadj", Topic: "spending",
			RegionCode: "wa", RegionType: "state", Frequency: "monthly",
			Observations: correlationMonthly(values, start),
		},
		{
			Key: "cpi.index.all_groups.aus", Topic: "cpi",
			RegionCode: "aus", RegionType: "national", Frequency: "quarterly",
			Observations: correlationQuarterly([]float64{1, 3, 2, 5}, start),
		},
		{
			Key: "spending.household.total.nsw.seasadj", Topic: "spending",
			RegionCode: "nsw", RegionType: "state", Frequency: "monthly",
			Observations: correlationMonthly(values, start),
		},
		{
			Key: "crime.victims.assault.wa", Topic: "crime",
			RegionCode: "wa", RegionType: "state", Frequency: "annual",
			Observations: correlationMonthly(values, start),
		},
		{
			Key: "markets.price_return_index.wa", Topic: "markets",
			RegionCode: "wa", RegionType: "state", Frequency: "monthly",
			Observations: correlationMonthly(values, start),
		},
	}

	rows, stats := computeCorrelationRows(series, 24, 12)
	if stats.BaseSeries != 2 {
		t.Fatalf("BaseSeries = %d, want 2", stats.BaseSeries)
	}
	if stats.EligiblePairs != 4 {
		t.Fatalf("EligiblePairs = %d, want 4", stats.EligiblePairs)
	}
	if stats.ComputedPairs != 4 || len(rows) != 4 {
		t.Fatalf("ComputedPairs=%d len(rows)=%d, want 4", stats.ComputedPairs, len(rows))
	}
	for _, row := range rows {
		if row.OverlaySeriesKey == "spending.household.total.nsw.seasadj" ||
			row.OverlaySeriesKey == "crime.victims.assault.wa" ||
			row.OverlaySeriesKey == "markets.price_return_index.wa" {
			t.Errorf("ineligible overlay was computed: %#v", row)
		}
		if row.N < 12 || row.WindowMonths != 24 {
			t.Errorf("row threshold/window drift: %#v", row)
		}
	}
}

func TestComputeCorrelationRowsSkipsInsufficientOverlapAndUndefinedCoefficients(t *testing.T) {
	start := time.Date(2023, 1, 1, 0, 0, 0, 0, time.UTC)
	baseValues := []float64{1, 4, 2, 8, 5, 7, 3, 9, 6, 10, 8, 11}
	series := []correlationSeries{
		{
			Key: "markets.short_interest_wavg.wa", Topic: "markets",
			RegionCode: "wa", RegionType: "state", Frequency: "monthly",
			Observations: correlationMonthly(baseValues, start),
		},
		{
			Key: "short.wa", Topic: "spending",
			RegionCode: "wa", RegionType: "state", Frequency: "monthly",
			Observations: correlationMonthly(baseValues[:11], start),
		},
		{
			Key: "constant.aus", Topic: "cpi",
			RegionCode: "aus", RegionType: "national", Frequency: "monthly",
			Observations: correlationMonthly([]float64{5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5}, start),
		},
	}

	rows, stats := computeCorrelationRows(series, 24, 12)
	if len(rows) != 0 || stats.ComputedPairs != 0 {
		t.Fatalf("rows=%#v stats=%#v, want no computed pairs", rows, stats)
	}
	if stats.EligiblePairs != 2 || stats.InsufficientPairs != 2 {
		t.Fatalf("stats=%#v, want 2 eligible and 2 insufficient/undefined", stats)
	}
}
