package main

import (
	"context"
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

func TestSelectSmokeTargetByCatalogSlug(t *testing.T) {
	want := crawlTargets[0]
	got, err := selectSmokeTarget(context.Background(), nil, "  "+want.Suburb+" ")
	if err != nil {
		t.Fatalf("catalog slug refused: %v", err)
	}
	if got.Suburb != want.Suburb {
		t.Fatalf("got %q, want %q", got.Suburb, want.Suburb)
	}
	// A display name or an unknown slug is refused before any query runs.
	for _, bad := range []string{"no-such-suburb-xyz", "Bondi Beach", "bondi;drop"} {
		if _, err := selectSmokeTarget(context.Background(), nil, bad); err == nil {
			t.Errorf("%q was accepted as a smoke suburb", bad)
		}
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
