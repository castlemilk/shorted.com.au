package main

import (
	"math"
	"testing"
)

// panel builds n suburbs that all discount at the same rate, each with the
// given number of active addresses.
func panel(n, active int, rate float64) []suburbDay {
	rows := make([]suburbDay, 0, n)
	for i := range n {
		rows = append(rows, suburbDay{
			salCode:       string(rune('a'+i%26)) + string(rune('a'+i/26)),
			active:        active,
			dropped:       int(math.Round(float64(active) * rate)),
			medianDropPct: 0.05,
			sweptRecently: true,
		})
	}
	return rows
}

// THE discriminating test. Cohorts differ in BOTH size and rate, which is the
// only condition under which a pooled ratio and an equal-weighted mean diverge.
//
// 115 small suburbs at 10%, then 385 large ones at 30%:
//   equal-weighted mean = (115*0.10 + 385*0.30) / 500          = 0.254
//   pooled ratio        = (115*4 + 385*120) / (115*40 + 385*400) = 0.29420...
//
// The pooled ratio is dragged toward the large cohort because it weights by
// listing volume. That is exactly how our crawl catalog growing 115 -> 500
// suburbs would have leaked into the published index as a market move.
func TestIndexWeightsSuburbsEqually(t *testing.T) {
	rows := append(panel(115, 40, 0.10), panel(385, 400, 0.30)...)

	got := aggregateIndex(rows, 20, 0.6)

	const wantEqualWeighted = 0.254
	const pooled = 0.2942 // what sum(dropped)/sum(active) would give

	if math.Abs(got.DropRate-wantEqualWeighted) > 1e-9 {
		t.Fatalf("DropRate = %.6f, want %.6f (equal-weighted mean of per-suburb rates)",
			got.DropRate, wantEqualWeighted)
	}
	if math.Abs(got.DropRate-pooled) < 1e-3 {
		t.Fatalf("DropRate = %.6f looks like the POOLED ratio %.4f — the index must "+
			"weight suburbs equally so large suburbs cannot dominate", got.DropRate, pooled)
	}
}

// Adding suburbs that discount at the SAME rate as the existing panel must not
// move the index at all. This does not by itself distinguish the two formulas
// (at a uniform rate they agree), but it states the real-world requirement:
// growing the catalog is not a market event.
func TestIndexIsUnmovedByCatalogExpansion(t *testing.T) {
	small := aggregateIndex(panel(115, 40, 0.10), 20, 0.6)

	expanded := append(panel(115, 40, 0.10), panel(385, 400, 0.10)...)
	big := aggregateIndex(expanded, 20, 0.6)

	if math.Abs(big.DropRate-small.DropRate) > 1e-9 {
		t.Fatalf("index moved on catalog expansion: %.6f -> %.6f (want unchanged)",
			small.DropRate, big.DropRate)
	}
	if small.PanelSuburbs != 115 || big.PanelSuburbs != 500 {
		t.Fatalf("panel sizes = %d, %d; want 115, 500", small.PanelSuburbs, big.PanelSuburbs)
	}
}

// A three-listing suburb reports a 33% rate off one cut. Without a floor it
// drags the national mean around.
func TestTinySuburbsExcludedFromPanel(t *testing.T) {
	rows := append(panel(10, 40, 0.10), suburbDay{
		salCode: "tiny", active: 3, dropped: 1, sweptRecently: true,
	})

	got := aggregateIndex(rows, 20, 0.6)

	if got.PanelSuburbs != 10 {
		t.Fatalf("PanelSuburbs = %d, want 10 (the 3-listing suburb is excluded)", got.PanelSuburbs)
	}
	if math.Abs(got.DropRate-0.10) > 1e-9 {
		t.Fatalf("DropRate = %.6f, want 0.10", got.DropRate)
	}
}

// 2026-08-13..15: the crawl stopped. Those days must render as a break, not as
// a collapse in discounting.
func TestUnderSweptDayIsFlaggedAsGap(t *testing.T) {
	rows := panel(100, 40, 0.10)
	for i := range 50 {
		rows[i].sweptRecently = false // only half the panel was swept
	}

	got := aggregateIndex(rows, 20, 0.6)

	if !got.IsGap {
		t.Fatalf("IsGap = false at coverage %.2f, want true", got.CoverageRatio)
	}
	if math.Abs(got.CoverageRatio-0.5) > 1e-9 {
		t.Fatalf("CoverageRatio = %.4f, want 0.5", got.CoverageRatio)
	}
}

func TestFullySweptDayIsNotAGap(t *testing.T) {
	got := aggregateIndex(panel(100, 40, 0.10), 20, 0.6)
	if got.IsGap {
		t.Fatalf("IsGap = true at coverage %.2f, want false", got.CoverageRatio)
	}
}

// An empty panel must not divide by zero.
func TestEmptyPanelIsZeroAndGapped(t *testing.T) {
	got := aggregateIndex(nil, 20, 0.6)
	if got.DropRate != 0 || got.PanelSuburbs != 0 {
		t.Fatalf("got %+v, want zero-valued", got)
	}
	if !got.IsGap {
		t.Fatalf("IsGap = false for an empty panel, want true")
	}
}

// A day where nothing was swept is a gap even if the caller passed a
// zero threshold — an unwired config must not publish a total outage as normal.
func TestZeroCoverageIsAlwaysAGap(t *testing.T) {
	rows := panel(50, 40, 0.10)
	for i := range rows {
		rows[i].sweptRecently = false
	}

	got := aggregateIndex(rows, 20, 0)

	if !got.IsGap {
		t.Fatalf("IsGap = false with zero coverage and gapThreshold 0, want true")
	}
}

// A zero-active suburb must not turn the day's index into NaN.
func TestZeroActiveSuburbDoesNotPoisonTheIndex(t *testing.T) {
	rows := append(panel(10, 40, 0.10), suburbDay{
		salCode: "empty", active: 0, dropped: 0, sweptRecently: true,
	})

	got := aggregateIndex(rows, 0, 0.6) // minActive 0 — the unsafe zero value

	if math.IsNaN(got.DropRate) || math.IsInf(got.DropRate, 0) {
		t.Fatalf("DropRate = %v, want a finite number", got.DropRate)
	}
	if math.Abs(got.DropRate-0.10) > 1e-9 {
		t.Fatalf("DropRate = %.6f, want 0.10 (the empty suburb is skipped)", got.DropRate)
	}
	if got.PanelSuburbs != 10 {
		t.Fatalf("PanelSuburbs = %d, want 10", got.PanelSuburbs)
	}
}
