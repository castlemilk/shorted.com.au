package main

import (
	"testing"
	"time"
)

// rotationMargin is how much of the freshness horizon the steady-state rotation
// is allowed to consume. At the shipped defaults (500 catalog / 120 per run =
// 100h against a 120h alarm) it sits at 83%.
const rotationMargin = 0.85

// steadyStateRotation is how long the crawl takes to cover the whole catalog
// once, at one run per day.
//
// NOT ceil(): selection is continuous — each run takes the N stalest suburbs,
// so a catalog of 500 at 120/run comes round every 500/120 = 4.17 days, not 5.
func steadyStateRotation(catalog, perRun int) time.Duration {
	if perRun <= 0 {
		return 0
	}
	return time.Duration(float64(catalog) / float64(perRun) * float64(24*time.Hour))
}

// The catalog size, the per-run cap and the alarm horizon are ONE decision, and
// until now that was only written down in prose, in two comments, in two files.
// That is exactly how the 60/72h pairing shipped: 500/60 implied an 8.3-day
// rotation against a 3-day alarm, so the alarm fired on the designed steady
// state and stopped meaning anything (measured 2026-08-18: median 117h staleness,
// oldest 305h).
//
// This test derives the rotation from the ACTUAL catalog rather than a copied
// number, so growing the catalog turns red here and names the fix, instead of
// silently re-creating a permanently-alarming crawl.
func TestCatalogRotationFitsFreshnessHorizon(t *testing.T) {
	for _, k := range []string{
		"CRAWL_DELTA_TTL_HOURS", "CRAWL_DELTA_CHURN_MIN", "CRAWL_DELTA_CHURN_DAYS",
		"CRAWL_DELTA_MAX_SUBURBS", "CRAWL_FRESHNESS_ALARM_HOURS", "CRAWL_FRESHNESS_WEBHOOK",
	} {
		t.Setenv(k, "")
	}

	delta := loadDeltaConfig()
	fresh := loadFreshnessConfig()
	catalog := len(crawlTargets)

	rotation := steadyStateRotation(catalog, delta.maxSuburbs)
	budget := time.Duration(float64(fresh.alarmAfter) * rotationMargin)

	if rotation > budget {
		wantPerRun := int(float64(catalog)/(float64(budget)/float64(24*time.Hour)) + 0.999)
		t.Fatalf(
			"catalog rotation %s exceeds %.0f%% of the %s freshness horizon (%s).\n"+
				"The catalog (%d), CRAWL_DELTA_MAX_SUBURBS (%d) and CRAWL_FRESHNESS_ALARM_HOURS (%s) are ONE decision.\n"+
				"Either raise CRAWL_DELTA_MAX_SUBURBS to >= %d (check the rig can finish a run that size inside CRAWL_TIMEOUT_MIN),\n"+
				"or raise CRAWL_FRESHNESS_ALARM_HOURS to >= %s and accept the staler data.",
			rotation.Round(time.Hour), rotationMargin*100, fresh.alarmAfter, budget.Round(time.Hour),
			catalog, delta.maxSuburbs, fresh.alarmAfter,
			wantPerRun,
			(rotation + rotation/5).Round(time.Hour),
		)
	}
}

// Guards the helper itself, including the regression that made the ceil()
// reading wrong: 500/120 is 4.17 days, not 5.
func TestSteadyStateRotation(t *testing.T) {
	if got := steadyStateRotation(500, 120); got.Round(time.Hour) != 100*time.Hour {
		t.Fatalf("500 catalog at 120/run = %s, want 100h", got.Round(time.Hour))
	}
	if got := steadyStateRotation(500, 60); got.Round(time.Hour) != 200*time.Hour {
		t.Fatalf("the pairing that broke the alarm: 500 at 60/run = %s, want 200h", got.Round(time.Hour))
	}
	if got := steadyStateRotation(500, 0); got != 0 {
		t.Fatalf("a zero cap must not divide by zero, got %s", got)
	}
}

// A guard that cannot fail is decoration. This pins the threshold behaviour:
// growing the catalog without raising the per-run cap must breach the budget.
func TestRotationGuardRejectsCatalogGrowthWithoutThroughput(t *testing.T) {
	const alarm = 120 * time.Hour
	budget := time.Duration(float64(alarm) * rotationMargin) // 102h

	// Today: 500 at 120/run.
	if got := steadyStateRotation(500, 120); got > budget {
		t.Fatalf("the shipped configuration must pass: %s > %s", got, budget)
	}
	// Add the three missing capitals and regional Australia at the same cap and
	// the crawl silently stops meeting its own alarm.
	for _, catalog := range []int{600, 800, 1000} {
		if got := steadyStateRotation(catalog, 120); got <= budget {
			t.Fatalf("catalog %d at 120/run rotates in %s, which should breach the %s budget", catalog, got, budget)
		}
	}
	// Raising the cap in step keeps it inside.
	if got := steadyStateRotation(1000, 240); got > budget {
		t.Fatalf("1000 at 240/run should fit: %s > %s", got, budget)
	}
}
