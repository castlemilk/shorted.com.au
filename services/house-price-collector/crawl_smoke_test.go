package main

import (
	"testing"
	"time"
)

func TestSmokeRunIDPattern(t *testing.T) {
	good := []string{"smoke-20261031T093000Z", "smoke-20261031T093000Z-0a1b2c3d"}
	bad := []string{
		"", "delta-20261031T093000Z", "smoke-20261031T093000Z-XYZ", "smoke-20261031T093000Z-0a1b2c3d4",
		"smoke-20261031T093000Z;rm", "smoke-../x", " smoke-20261031T093000Z",
	}
	for _, id := range good {
		if !smokeRunIDPattern.MatchString(id) {
			t.Errorf("%q should be a smoke run id", id)
		}
	}
	for _, id := range bad {
		if smokeRunIDPattern.MatchString(id) {
			t.Errorf("%q should not be a smoke run id", id)
		}
	}
}

// A smoke run enqueues exactly one suburb, once per configured portal, at the smoke priority.
func TestSmokeJobsAreOneSuburbPerPortalAtPriority(t *testing.T) {
	target := crawlTargets[0]
	jobs := buildEnqueueJobs([]CrawlTarget{target}, []string{"rea", "domain"}, "listings")
	for i := range jobs {
		jobs[i].Priority = smokeEnqueuePriority
	}
	if len(jobs) != 2 {
		t.Fatalf("got %d jobs, want one per portal", len(jobs))
	}
	for _, j := range jobs {
		if j.Suburb != target.Display || j.Priority != smokeEnqueuePriority || j.Kind != "housing" {
			t.Fatalf("job %+v does not name the one target at the smoke priority", j)
		}
	}
}

func TestChooseSmokeTargetByCatalogSlug(t *testing.T) {
	want := crawlTargets[0]
	got, err := chooseSmokeTarget("  "+want.Suburb+" ", map[string]bool{}, nil)
	if err != nil {
		t.Fatalf("catalog slug refused: %v", err)
	}
	if got.Suburb != want.Suburb {
		t.Fatalf("got %q, want %q", got.Suburb, want.Suburb)
	}
	// A display name or an unknown slug is refused.
	for _, bad := range []string{"no-such-suburb-xyz", "Bondi Beach", "bondi;drop"} {
		if _, err := chooseSmokeTarget(bad, map[string]bool{}, nil); err == nil {
			t.Errorf("%q was accepted as a smoke suburb", bad)
		}
	}
}

// An explicit suburb that already has open jobs is refused: the enqueue would dedupe onto them
// at their priority, and the smoke would not be prioritised.
func TestChooseSmokeTargetRefusesAQueuedSuburb(t *testing.T) {
	want := crawlTargets[0].Suburb
	if _, err := chooseSmokeTarget(want, map[string]bool{want: true}, nil); err == nil {
		t.Fatal("a suburb with open jobs was accepted for an explicit smoke")
	}
}

// With no suburb, a queued suburb is never chosen, even when it is the stalest.
func TestChooseSmokeTargetSkipsQueuedSuburbs(t *testing.T) {
	old := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	newer := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	mk := func(slug string, last *time.Time) suburbFreshness {
		return suburbFreshness{Target: CrawlTarget{Suburb: slug}, LastCrawled: last}
	}
	fresh := []suburbFreshness{mk("never-queued-no", nil), mk("old-but-queued", &old), mk("newer-free", &newer)}
	queued := map[string]bool{"never-queued-no": true, "old-but-queued": true}
	got, err := chooseSmokeTarget("", queued, fresh)
	if err != nil {
		t.Fatal(err)
	}
	if got.Suburb != "newer-free" {
		t.Fatalf("picked %q; the only suburb without open jobs is newer-free", got.Suburb)
	}
	all := map[string]bool{"never-queued-no": true, "old-but-queued": true, "newer-free": true}
	if _, err := chooseSmokeTarget("", all, fresh); err == nil {
		t.Fatal("with every suburb queued there is nothing to smoke, and that must be an error")
	}
}

func TestPickStalestNeverCrawledThenOldest(t *testing.T) {
	old := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	newer := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	mk := func(slug string, last *time.Time) suburbFreshness {
		return suburbFreshness{Target: CrawlTarget{Suburb: slug}, LastCrawled: last}
	}
	got, ok := pickStalest([]suburbFreshness{mk("a", &newer), mk("b", &old), mk("c", nil)})
	if !ok || got.Suburb != "c" {
		t.Fatalf("never-crawled suburb should win, got %+v ok=%v", got, ok)
	}
	got, ok = pickStalest([]suburbFreshness{mk("a", &newer), mk("b", &old)})
	if !ok || got.Suburb != "b" {
		t.Fatalf("oldest crawl should win, got %+v ok=%v", got, ok)
	}
	if _, ok := pickStalest(nil); ok {
		t.Fatal("an empty catalog must report no target")
	}
}

// A smoke run is all or nothing: one target BrandBrain did not create refuses the whole run.
func TestSmokeDeduplicatedCountRefusesAPartialRun(t *testing.T) {
	created := []enqueueTargetItem{{Source: "rea", Created: true}, {Source: "domain", Created: true}}
	if n := smokeDeduplicatedCount(created); n != 0 {
		t.Fatalf("all created: %d deduplicated, want 0", n)
	}
	one := []enqueueTargetItem{{Source: "rea", Created: true}, {Source: "domain", Created: false}}
	if n := smokeDeduplicatedCount(one); n != 1 {
		t.Fatalf("one deduplicated: %d, want 1", n)
	}
	if smokeExitDeduplicated == 7 || smokeExitDeduplicated == 0 {
		t.Fatalf("the deduplicated exit %d must not collide with the failure (7) or success (0) codes", smokeExitDeduplicated)
	}
}
