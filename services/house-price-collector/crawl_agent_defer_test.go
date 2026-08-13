package main

import (
	"context"
	"testing"
	"time"
)

// TestCrawlAgentJob_CircuitOpenDefersInsteadOfBankingSuccess is the regression
// guard for the bug this fixes.
//
// When every source a job owns is skipped, crawlAgentJob used to report
// "succeeded" unconditionally, with the detail "both sources skipped (swept
// within the resume window)". That is true for a resume-window skip and FALSE
// for a circuit-breaker skip: the portal was blocking, nothing was fetched, and
// the work is still owed. Reporting success consumed the queued job — it left
// the queue, never retried, and the suburb's last-crawled never advanced, so the
// suburb silently stopped being crawled while the queue counted it done.
//
// Observed live: Unley SA 5061 last produced listings on 2026-08-04 and was
// "succeeded" into staleness for four days, driving the freshness alarm, while
// 112 Domain jobs a day took the same path — about a quarter of all reported
// successes were sweeps that never ran.
func TestCrawlAgentJob_CircuitOpenDefersInsteadOfBankingSuccess(t *testing.T) {
	now := time.Now()
	cb := newCircuitBreaker(1, 5*time.Minute, 30*time.Minute)
	// Trip rea's circuit so the job's only source is skipped for blocking.
	if opened, _ := cb.record("rea", true, now); !opened {
		t.Fatal("expected the rea circuit to open")
	}
	if open, _ := cb.skip("rea", now); !open {
		t.Fatal("expected the rea circuit to be open")
	}

	job := &agentCrawlJob{ID: "job-1", Kind: "housing", Suburb: "Unley", State: "SA", Postcode: "5061", Source: "rea", Tier: "listings"}
	cfg := listingsConfig{crawlConfig: crawlConfig{dryRun: true}, resumeWindow: time.Hour}

	summary, status, errMsg, wrote, retryAfter := crawlAgentJob(
		context.Background(), nil, nil, cfg, job, resumeSet{}, cb, nil)

	if status != "deferred" {
		t.Fatalf("status = %q, want \"deferred\" — a sweep blocked by an open circuit was never attempted and must not be banked as a terminal outcome", status)
	}
	if retryAfter <= 0 {
		t.Fatalf("retryAfter = %v, want the breaker's remaining cooldown — without it the queue re-serves the job immediately and the agent spins", retryAfter)
	}
	if retryAfter > 30*time.Minute {
		t.Fatalf("retryAfter = %v, want <= the breaker's max cooldown", retryAfter)
	}
	if wrote {
		t.Fatal("a deferred job wrote nothing and must not gate the end-of-run MV refresh")
	}
	if errMsg == "" {
		t.Fatal("a defer must carry a reason so the queue records why the job came back")
	}
	if summary.Events != 0 || summary.Listings != 0 {
		t.Fatalf("a deferred job must report zero counts: %+v", summary)
	}
	if summary.Detail == "both sources skipped (swept within the resume window)" {
		t.Fatal("the detail still blames the resume window for a circuit-breaker skip")
	}
}

// The honest no-op must keep working: both sources genuinely swept inside the
// resume window is finished work, not deferred work.
func TestCrawlAgentJob_ResumeWindowSkipStillSucceeds(t *testing.T) {
	now := time.Now().UTC()
	cb := newCircuitBreaker(2, 5*time.Minute, 30*time.Minute)

	job := &agentCrawlJob{ID: "job-2", Kind: "housing", Suburb: "Unley", State: "SA", Postcode: "5061", Source: "rea", Tier: "listings"}
	cfg := listingsConfig{crawlConfig: crawlConfig{dryRun: true}, resumeWindow: 24 * time.Hour}

	target, _ := resolveCrawlTarget(job)
	rs := resumeSet{resumeKey("rea", target.regionCode()): now.Add(-time.Minute)}

	_, status, _, _, retryAfter := crawlAgentJob(
		context.Background(), nil, nil, cfg, job, rs, cb, nil)

	if status != "succeeded" {
		t.Fatalf("status = %q, want \"succeeded\" — a source swept inside the resume window is done, not deferred", status)
	}
	if retryAfter != 0 {
		t.Fatalf("retryAfter = %v, want 0 for a non-deferred outcome", retryAfter)
	}
}
