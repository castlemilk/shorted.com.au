package main

import (
	"math"
	"strings"
	"testing"
)

// panel builds n suburbs that all discount at the same rate, each with the
// given number of active addresses. Every row here represents an actual sweep
// observation (that is what sourcing from querySuburbDays now guarantees), so
// there is no sweptRecently flag to set.
func panel(n, active int, rate float64) []suburbDay {
	rows := make([]suburbDay, 0, n)
	for i := range n {
		rows = append(rows, suburbDay{
			salCode:       string(rune('a'+i%26)) + string(rune('a'+i/26)),
			active:        active,
			dropped:       int(math.Round(float64(active) * rate)),
			medianDropPct: 0.05,
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

	got := aggregateIndex(rows, 20, 0.6, 500)

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
	small := aggregateIndex(panel(115, 40, 0.10), 20, 0.6, 500)

	expanded := append(panel(115, 40, 0.10), panel(385, 400, 0.10)...)
	big := aggregateIndex(expanded, 20, 0.6, 500)

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
		salCode: "tiny", active: 3, dropped: 1,
	})

	got := aggregateIndex(rows, 20, 0.6, 500)

	if got.PanelSuburbs != 10 {
		t.Fatalf("PanelSuburbs = %d, want 10 (the 3-listing suburb is excluded)", got.PanelSuburbs)
	}
	if math.Abs(got.DropRate-0.10) > 1e-9 {
		t.Fatalf("DropRate = %.6f, want 0.10", got.DropRate)
	}
}

// Bug 1 regression. Under the old sourcing the panel collapsed 499 -> 24 as
// the date approached today, because "active on date d" really meant "re-
// crawled since d". Coverage must be measured against the catalog, so a day
// where we only observed a fraction of it is visibly low-coverage rather than
// silently renormalised.
func TestCoverageIsMeasuredAgainstTheCatalog(t *testing.T) {
	got := aggregateIndex(panel(100, 40, 0.10), 20, 0.6, 500)
	if math.Abs(got.CoverageRatio-0.2) > 1e-9 {
		t.Fatalf("CoverageRatio = %.4f, want 0.2 (100 observed of a 500 catalog)", got.CoverageRatio)
	}
	if !got.IsGap {
		t.Fatalf("IsGap = false at 20%% catalog coverage, want true")
	}
}

// Bug 2 regression. On 2026-08-14 the crawl swept nothing, yet the old code
// reported coverage=1.00 gap=false because the flag was true by construction.
func TestFullCatalogCoverageIsNotAGap(t *testing.T) {
	got := aggregateIndex(panel(500, 40, 0.10), 20, 0.6, 500)
	if got.IsGap {
		t.Fatalf("IsGap = true at full catalog coverage, want false")
	}
}

// A catalog size of 0 must not divide by zero or report a spurious full house.
func TestZeroCatalogIsAGap(t *testing.T) {
	got := aggregateIndex(panel(10, 40, 0.10), 20, 0.6, 0)
	if !got.IsGap || math.IsNaN(got.CoverageRatio) || math.IsInf(got.CoverageRatio, 0) {
		t.Fatalf("got %+v, want a gap with a finite coverage ratio", got)
	}
}

// An empty panel must not divide by zero.
func TestEmptyPanelIsZeroAndGapped(t *testing.T) {
	got := aggregateIndex(nil, 20, 0.6, 500)
	if got.DropRate != 0 || got.PanelSuburbs != 0 {
		t.Fatalf("got %+v, want zero-valued", got)
	}
	if !got.IsGap {
		t.Fatalf("IsGap = false for an empty panel, want true")
	}
}

// A zero-active suburb must not turn the day's index into NaN.
func TestZeroActiveSuburbDoesNotPoisonTheIndex(t *testing.T) {
	rows := append(panel(10, 40, 0.10), suburbDay{
		salCode: "empty", active: 0, dropped: 0,
	})

	got := aggregateIndex(rows, 0, 0.6, 500) // minActive 0 — the unsafe zero value

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

// Regression: coverage was measured against the NATIONAL catalog for every
// grain, so NSW's 135 suburbs read as 135/500 = 0.27 and every state row was
// permanently flagged a gap. Coverage must use the catalog for the grain
// being aggregated.
func TestStateCoverageUsesTheStateCatalog(t *testing.T) {
	// A state fully covered by its own 135-suburb catalog is NOT a gap, even
	// though 135 is a small fraction of the 500-suburb national catalog.
	got := aggregateIndex(panel(135, 40, 0.10), 20, 0.6, 135)
	if got.IsGap {
		t.Fatalf("IsGap = true at full state coverage (135/135), want false")
	}
	if math.Abs(got.CoverageRatio-1.0) > 1e-9 {
		t.Fatalf("CoverageRatio = %.4f, want 1.0", got.CoverageRatio)
	}
}

// catalogSizes.forState resolves each grain's own denominator. An unknown
// state must read as zero, not silently fall back to Total — that would
// reintroduce the state-coverage bug in a different shape (a state present
// in the panel but missing from the catalog query would read as "fully
// covered by the national catalog" instead of "no catalog, definitely a
// gap").
func TestCatalogSizesForStateDoesNotFallBackToNational(t *testing.T) {
	c := catalogSizes{
		Total:   500,
		ByState: map[string]int{"NSW": 135, "VIC": 135, "QLD": 97, "WA": 67, "SA": 66},
	}

	if got := c.forState("NSW"); got != 135 {
		t.Fatalf("forState(NSW) = %d, want 135", got)
	}
	if got := c.forState("TAS"); got != 0 {
		t.Fatalf("forState(TAS) = %d, want 0 (unknown state must not silently return Total=%d)", got, c.Total)
	}
}

// Bug 1 regression at the SQL level: the active CTE must source membership
// from a trailing sweep window on last_seen_at, not from a
// first_seen_at <= d <= last_seen_at spanning-date filter (which measures
// crawl coverage, not market presence).
func TestActiveCTEUsesSweepWindowNotSpanningDates(t *testing.T) {
	sql := suburbDaysSQL()

	active := sql[strings.Index(sql, "active AS ("):strings.Index(sql, "dropped AS (")]
	if strings.Contains(active, "first_seen_at") {
		t.Fatalf("active CTE must not filter on first_seen_at (that reconstructs crawl "+
			"coverage rather than sweep presence):\n%s", active)
	}
	if !strings.Contains(active, "l.last_seen_at::date BETWEEN $1::date - ($2::int - 1) AND $1::date") {
		t.Fatalf("active CTE is not sourced from the trailing sweep window:\n%s", active)
	}
}

// The numerator must use the SAME sweep-window membership as the active CTE,
// or a listing that cut its price and then fell out of the window inflates
// drop_rate above 1.
func TestDroppedCTEIsConstrainedToTheSweepWindow(t *testing.T) {
	sql := suburbDaysSQL()

	dropped := sql[strings.Index(sql, "dropped AS ("):]
	if !strings.Contains(dropped, "l.last_seen_at::date BETWEEN $1::date - ($2::int - 1) AND $1::date") {
		t.Fatalf("dropped CTE is not constrained to the same sweep window as active suburbs:\n%s", dropped)
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
	got := suburbPoint(suburbDay{salCode: "tiny", active: 4, dropped: 1})

	if got.PanelSuburbs != 1 {
		t.Fatalf("PanelSuburbs = %d, want 1", got.PanelSuburbs)
	}
	if math.Abs(got.DropRate-0.25) > 1e-9 {
		t.Fatalf("DropRate = %.4f, want 0.25", got.DropRate)
	}
	if got.IsGap {
		t.Fatalf("IsGap = true for a suburb with active addresses, want false")
	}
	if math.Abs(got.CoverageRatio-1.0) > 1e-9 {
		t.Fatalf("CoverageRatio = %.4f, want 1.0 (a suburb is its own catalog)", got.CoverageRatio)
	}
}

// suburbDay rows only ever come from querySuburbDays' sweep-window filter, so
// a suburb with zero active addresses cannot actually occur in practice — but
// the function still must not report a false full-coverage reading if it did.
func TestSuburbPointZeroActiveIsAGapAndNotNaN(t *testing.T) {
	got := suburbPoint(suburbDay{salCode: "x", active: 0, dropped: 0})
	if math.IsNaN(got.DropRate) || math.IsInf(got.DropRate, 0) {
		t.Fatalf("DropRate = %v, want a finite number", got.DropRate)
	}
	if !got.IsGap {
		t.Fatalf("IsGap = false for a suburb with zero active addresses, want true")
	}
}

// The 7-day floor is load-bearing: without it ~83% of delist->relist pairs
// are REA page-truncation artefacts (450 REA pairs, 188 of them <=2 days
// apart), not vendors withdrawing and returning. See indexRelistGapDays for
// the full measurement. This pins that the query actually parameterises the
// gap rather than hardcoding or dropping it.
func TestCapitulationRequiresARealGap(t *testing.T) {
	sql := capitulationSQL()
	if !strings.Contains(sql, "$3::int") {
		t.Fatalf("capitulation query does not parameterise the relist gap:\n%s", sql)
	}
	if !strings.Contains(sql, "relisted_at - delisted_at > $3::int * interval '1 day'") {
		t.Fatalf("capitulation query does not gate on the relist gap:\n%s", sql)
	}
	if !strings.Contains(sql, "event_type = 'relisted'") || !strings.Contains(sql, "event_type = 'delisted'") {
		t.Fatalf("capitulation query does not pair delisted->relisted events:\n%s", sql)
	}
}

// The window filter must apply to the RELIST date, not the delist date — a
// listing delisted 40 days ago and relisted yesterday IS a capitulation event
// today, and must not be excluded just because its delisting is stale.
func TestCapitulationWindowAppliesToRelistDateNotDelistDate(t *testing.T) {
	sql := capitulationSQL()
	if !strings.Contains(sql, "relisted_at::date <= $1::date") || !strings.Contains(sql, "relisted_at::date >  $1::date - $2::int") {
		t.Fatalf("capitulation query does not window on the relist date:\n%s", sql)
	}
	if strings.Contains(sql, "delisted_at::date <= $1::date") {
		t.Fatalf("capitulation query must not also window on the delist date:\n%s", sql)
	}
}
