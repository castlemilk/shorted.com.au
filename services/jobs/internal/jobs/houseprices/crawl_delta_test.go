package houseprices

import (
	"testing"
	"time"
)

// tgt is a tiny CrawlTarget builder for delta/freshness tests.
func tgt(display, state, postcode string) CrawlTarget {
	return CrawlTarget{Display: display, State: state, Postcode: postcode, Suburb: display}
}

// ago returns a *time.Time `d` before `now`.
func ago(now time.Time, d time.Duration) *time.Time {
	t := now.Add(-d)
	return &t
}

func defaultDeltaCfg() deltaConfig {
	return deltaConfig{ttl: 24 * time.Hour, churnMin: 1, churnDays: 7, maxSuburbs: 60}
}

func hasTarget(sel deltaSelection, display string) bool {
	for _, t := range sel.Targets {
		if t.Display == display {
			return true
		}
	}
	return false
}

func TestSelectDeltaSuburbs_SelectsNeverStaleChurny(t *testing.T) {
	now := time.Date(2026, 7, 22, 3, 0, 0, 0, time.UTC)
	cfg := defaultDeltaCfg()
	rows := []suburbFreshness{
		{Target: tgt("NeverSub", "NSW", "2000"), LastCrawled: nil},                                // never
		{Target: tgt("FreshQuiet", "NSW", "2001"), LastCrawled: ago(now, 2*time.Hour)},            // fresh + no churn → NOT selected
		{Target: tgt("StaleSub", "VIC", "3000"), LastCrawled: ago(now, 48*time.Hour)},             // stale
		{Target: tgt("ChurnySub", "QLD", "4000"), LastCrawled: ago(now, 3*time.Hour), Churn7d: 5}, // fresh but churny
	}

	sel := selectDeltaSuburbs(rows, cfg, now)

	if len(sel.Targets) != 3 {
		t.Fatalf("selected %d, want 3 (%+v)", len(sel.Targets), sel.Targets)
	}
	if hasTarget(sel, "FreshQuiet") {
		t.Fatalf("FreshQuiet should NOT be selected (fresh, no churn)")
	}
	for _, want := range []string{"NeverSub", "StaleSub", "ChurnySub"} {
		if !hasTarget(sel, want) {
			t.Fatalf("%s should be selected", want)
		}
	}
	if sel.Never != 1 || sel.Stale != 1 || sel.Churny != 1 {
		t.Fatalf("reason breakdown = never:%d stale:%d churny:%d, want 1/1/1", sel.Never, sel.Stale, sel.Churny)
	}
	if sel.Dropped != 0 {
		t.Fatalf("Dropped = %d, want 0", sel.Dropped)
	}
}

func TestSelectDeltaSuburbs_Ordering(t *testing.T) {
	now := time.Date(2026, 7, 22, 3, 0, 0, 0, time.UTC)
	cfg := defaultDeltaCfg()
	// Deliberately out of rank order in the input.
	rows := []suburbFreshness{
		{Target: tgt("StaleOld", "NSW", "2000"), LastCrawled: ago(now, 100*time.Hour)},            // stale, oldest
		{Target: tgt("ChurnyHi", "VIC", "3000"), LastCrawled: ago(now, 30*time.Hour), Churn7d: 9}, // stale + churniest
		{Target: tgt("Never", "QLD", "4000"), LastCrawled: nil},                                   // never
		{Target: tgt("StaleMid", "SA", "5000"), LastCrawled: ago(now, 50*time.Hour)},              // stale, middle age
	}

	sel := selectDeltaSuburbs(rows, cfg, now)

	want := []string{"Never", "ChurnyHi", "StaleOld", "StaleMid"}
	if len(sel.Targets) != len(want) {
		t.Fatalf("selected %d, want %d", len(sel.Targets), len(want))
	}
	for i, w := range want {
		if sel.Targets[i].Display != w {
			gotOrder := make([]string, len(sel.Targets))
			for j, tg := range sel.Targets {
				gotOrder[j] = tg.Display
			}
			t.Fatalf("order = %v, want %v", gotOrder, want)
		}
	}
}

func TestSelectDeltaSuburbs_CapAndDropped(t *testing.T) {
	now := time.Date(2026, 7, 22, 3, 0, 0, 0, time.UTC)
	cfg := defaultDeltaCfg()
	cfg.maxSuburbs = 2
	rows := []suburbFreshness{
		{Target: tgt("Never1", "NSW", "2000"), LastCrawled: nil},
		{Target: tgt("Never2", "NSW", "2001"), LastCrawled: nil},
		{Target: tgt("StaleA", "VIC", "3000"), LastCrawled: ago(now, 40*time.Hour)},
		{Target: tgt("StaleB", "VIC", "3001"), LastCrawled: ago(now, 30*time.Hour)},
	}

	sel := selectDeltaSuburbs(rows, cfg, now)

	if len(sel.Targets) != 2 {
		t.Fatalf("selected %d, want 2 (capped)", len(sel.Targets))
	}
	if sel.Dropped != 2 {
		t.Fatalf("Dropped = %d, want 2", sel.Dropped)
	}
	// The two never-crawled rank first, so they survive the cap.
	if !hasTarget(sel, "Never1") || !hasTarget(sel, "Never2") {
		t.Fatalf("expected the two never-crawled suburbs to survive the cap, got %+v", sel.Targets)
	}
}

func TestSelectDeltaSuburbs_ChurnDisabledWhenMinZero(t *testing.T) {
	now := time.Date(2026, 7, 22, 3, 0, 0, 0, time.UTC)
	cfg := defaultDeltaCfg()
	cfg.churnMin = 0 // churn signal off
	rows := []suburbFreshness{
		{Target: tgt("FreshChurny", "NSW", "2000"), LastCrawled: ago(now, 1*time.Hour), Churn7d: 50},
	}
	sel := selectDeltaSuburbs(rows, cfg, now)
	if len(sel.Targets) != 0 {
		t.Fatalf("churnMin=0 should disable the churn signal; selected %+v", sel.Targets)
	}
}

func TestSelectDeltaSuburbs_StaleTakesPrecedenceOverChurnyInReason(t *testing.T) {
	now := time.Date(2026, 7, 22, 3, 0, 0, 0, time.UTC)
	cfg := defaultDeltaCfg()
	// Both stale AND churny → primary reason is "stale" (never > stale > churny).
	rows := []suburbFreshness{
		{Target: tgt("Both", "NSW", "2000"), LastCrawled: ago(now, 48*time.Hour), Churn7d: 4},
	}
	sel := selectDeltaSuburbs(rows, cfg, now)
	if sel.Stale != 1 || sel.Churny != 0 || sel.Never != 0 {
		t.Fatalf("reason = never:%d stale:%d churny:%d, want 0/1/0", sel.Never, sel.Stale, sel.Churny)
	}
}

func TestFreshnessKey_Normalises(t *testing.T) {
	a := freshnessKey("St Kilda", "vic", " 3182 ")
	b := freshnessKey("ST KILDA", "VIC", "3182")
	if a != b {
		t.Fatalf("keys differ: %q vs %q", a, b)
	}
}
