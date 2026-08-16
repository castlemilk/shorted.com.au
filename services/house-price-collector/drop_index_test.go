package main

import (
	"math"
	"strings"
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

// A single large pgx.Batch hangs against the Supabase transaction pooler, so
// the chunk size must stay bounded. Pinned because the failure mode is a hang,
// not an error — it would look like the job simply stopped.
func TestIndexBatchChunkIsBounded(t *testing.T) {
	if indexBatchChunk <= 0 || indexBatchChunk > 200 {
		t.Fatalf("indexBatchChunk = %d, want a bounded chunk in (0, 200]", indexBatchChunk)
	}
}

// The numerator must be constrained to listings that were active on the day,
// or a listing that cut its price and then delisted inflates drop_rate above 1.
func TestDroppedCTEIsConstrainedToActiveOnDate(t *testing.T) {
	sql := suburbDaysSQL()

	dropped := sql[strings.Index(sql, "dropped AS ("):]
	if !strings.Contains(dropped, "l.first_seen_at::date <= $1::date") ||
		!strings.Contains(dropped, "l.last_seen_at::date  >= $1::date") {
		t.Fatalf("dropped CTE is not constrained to listings active on the date:\n%s", dropped)
	}
}

func TestUpsertIndexPointSQLIsIdempotent(t *testing.T) {
	sql := upsertIndexPointSQL()
	if !strings.Contains(sql, "ON CONFLICT (snapshot_date, grain, grain_key) DO UPDATE") {
		t.Fatalf("upsert must repair on re-run, got:\n%s", sql)
	}
	if !strings.Contains(sql, "computed_at = now()") {
		t.Fatalf("a repaired row must record when it was recomputed, got:\n%s", sql)
	}
}

// Rolling suburbs up to a state must not silently drop rows with no state.
func TestGroupByStateSkipsUnknownState(t *testing.T) {
	rows := []suburbDay{
		{salCode: "a", stateCode: "NSW", active: 40, dropped: 4},
		{salCode: "b", stateCode: "VIC", active: 40, dropped: 4},
		{salCode: "c", stateCode: "", active: 40, dropped: 4},
	}
	got := groupByState(rows)
	if len(got) != 2 {
		t.Fatalf("groupByState returned %d states, want 2 (the blank state is skipped)", len(got))
	}
	if len(got["NSW"]) != 1 || len(got["VIC"]) != 1 {
		t.Fatalf("unexpected grouping: %+v", got)
	}
}

// A suburb's own page shows its own rate. The >=20-active floor deliberately
// does NOT apply here: the floor exists to stop small suburbs distorting an
// AGGREGATE, and a suburb's own rate is not distorted by being small.
func TestSuburbPointIgnoresTheAggregateFloor(t *testing.T) {
	got := suburbPoint(suburbDay{salCode: "tiny", active: 4, dropped: 1, sweptRecently: true})

	if got.PanelSuburbs != 1 {
		t.Fatalf("PanelSuburbs = %d, want 1", got.PanelSuburbs)
	}
	if math.Abs(got.DropRate-0.25) > 1e-9 {
		t.Fatalf("DropRate = %.4f, want 0.25", got.DropRate)
	}
	if got.IsGap {
		t.Fatalf("IsGap = true for a swept suburb, want false")
	}
}

func TestSuburbPointUnsweptIsAGap(t *testing.T) {
	got := suburbPoint(suburbDay{salCode: "x", active: 40, dropped: 4, sweptRecently: false})
	if !got.IsGap {
		t.Fatalf("IsGap = false for an unswept suburb, want true")
	}
}

func TestSuburbPointZeroActiveIsNotNaN(t *testing.T) {
	got := suburbPoint(suburbDay{salCode: "x", active: 0, dropped: 0, sweptRecently: true})
	if math.IsNaN(got.DropRate) || math.IsInf(got.DropRate, 0) {
		t.Fatalf("DropRate = %v, want a finite number", got.DropRate)
	}
}
