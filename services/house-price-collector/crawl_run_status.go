package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// crawl_run_status.go writes the residential crawl's HEALTH RECORD so the Mac-based
// crawl appears as a first-class scheduled job in the admin jobs dashboard.
//
// The dashboard's /api/admin/jobs endpoint reads GCP Cloud Run Job executions +
// Cloud Scheduler triggers directly (jobmonitor) — it has zero visibility into
// anything off GCP. The residential crawl runs on a Mac (Kasada needs a residential
// IP + warm host-Chrome, so it CANNOT run on Cloud Run), so it must self-report to a
// DB table the API can merge in. Each scheduled invocation upserts ONE row keyed by
// (run_type, host); a launchd wrapper loops `-mode agent` several rounds per run and
// each round accumulates its counts into the same row (keyed by run_id). A DEAD RIG
// stops writing → finished_at goes stale → the dashboard auto-flips the row to
// warning/critical. All writes are BEST-EFFORT: a failure here never fails the crawl.

// crawlRunStatusRecord is one round's health contribution. finished_at is set to
// now() by the upsert; started_at is this run's first-round start.
type crawlRunStatusRecord struct {
	RunType         string
	Host            string
	RunID           string
	StartedAt       time.Time
	Status          string
	SuburbsSelected int
	SuburbsDone     int
	ListingsTouched int
	EventsWritten   int
	BlockedCount    int
	RewarmNeeded    bool
	Detail          string
}

// crawlRunType resolves this invocation's run-type tag. The launchd wrappers export
// CRAWL_RUN_TYPE=delta|full; a bare `-mode agent` (manual / bundled agent) defaults
// to "agent".
func crawlRunType() string {
	rt := strings.ToLower(strings.TrimSpace(os.Getenv("CRAWL_RUN_TYPE")))
	switch rt {
	case "delta", "full", "agent":
		return rt
	default:
		return "agent"
	}
}

// crawlRunID resolves the stable per-run id used to ACCUMULATE the several rounds of
// one launchd run into a single health row. The wrappers export CRAWL_RUN_ID once so
// every round (a separate process) shares it; absent that, each process gets its own
// id (so a manual single-round `-mode agent` simply replaces the row — no accumulation
// to speak of, which is correct for a one-shot run).
func crawlRunID(runType string) string {
	if v := strings.TrimSpace(os.Getenv("CRAWL_RUN_ID")); v != "" {
		return v
	}
	return fmt.Sprintf("%s-%d", runType, time.Now().UnixNano())
}

// crawlHost resolves the rig's hostname for the health row's PK.
func crawlHost() string {
	h, _ := os.Hostname()
	if strings.TrimSpace(h) == "" {
		return "collector"
	}
	return h
}

// deriveCrawlRunStatus maps a round's outcome to the health status enum, in
// descending severity:
//   - "error"   : a fatal error and nothing got done (e.g. the claim call failed
//     before any suburb ran) — the round accomplished nothing.
//   - "rewarm"  : the session tripped the re-warm signal (circuit breaker) — Chrome
//     needs a re-warm before the next run.
//   - "blocked" : sweeps were blocked and NO events were written — a fully wasted
//     round (Kasada/Akamai serving stubs, or an IP throttle).
//   - "partial" : some sweeps blocked but events were still written — degraded but
//     productive.
//   - "ok"      : clean run (or a legitimate no-change sweep).
func deriveCrawlRunStatus(events, blocked, done int, rewarm, fatalErr bool) string {
	switch {
	case fatalErr && done == 0:
		return "error"
	case rewarm:
		return "rewarm"
	case blocked > 0 && events == 0:
		return "blocked"
	case blocked > 0:
		return "partial"
	default:
		return "ok"
	}
}

// upsertCrawlRunStatus writes ONE round's health contribution. Rounds that share the
// row's run_id ACCUMULATE their counts (and OR the rewarm flag), keeping the run's
// original started_at; a round with a NEW run_id REPLACES the row wholesale (a fresh
// run) and clears the previous run's freshness annotation. finished_at is always
// now() — that is the freshness signal the dashboard uses for dead-rig detection.
func upsertCrawlRunStatus(ctx context.Context, pool *pgxpool.Pool, rec crawlRunStatusRecord) error {
	const q = `
		INSERT INTO crawl_run_status (
			run_type, host, run_id, started_at, finished_at, status,
			suburbs_selected, suburbs_done, listings_touched, events_written,
			blocked_count, rewarm_needed, detail, updated_at)
		VALUES ($1,$2,$3,$4, now(), $5, $6,$7,$8,$9, $10,$11, NULLIF($12,''), now())
		ON CONFLICT (run_type, host) DO UPDATE SET
			run_id      = EXCLUDED.run_id,
			started_at  = CASE WHEN crawl_run_status.run_id IS NOT DISTINCT FROM EXCLUDED.run_id
			                   THEN crawl_run_status.started_at ELSE EXCLUDED.started_at END,
			finished_at = EXCLUDED.finished_at,
			status      = EXCLUDED.status,
			suburbs_selected = CASE WHEN crawl_run_status.run_id IS NOT DISTINCT FROM EXCLUDED.run_id
			                   THEN crawl_run_status.suburbs_selected + EXCLUDED.suburbs_selected ELSE EXCLUDED.suburbs_selected END,
			suburbs_done = CASE WHEN crawl_run_status.run_id IS NOT DISTINCT FROM EXCLUDED.run_id
			                   THEN crawl_run_status.suburbs_done + EXCLUDED.suburbs_done ELSE EXCLUDED.suburbs_done END,
			listings_touched = CASE WHEN crawl_run_status.run_id IS NOT DISTINCT FROM EXCLUDED.run_id
			                   THEN crawl_run_status.listings_touched + EXCLUDED.listings_touched ELSE EXCLUDED.listings_touched END,
			events_written = CASE WHEN crawl_run_status.run_id IS NOT DISTINCT FROM EXCLUDED.run_id
			                   THEN crawl_run_status.events_written + EXCLUDED.events_written ELSE EXCLUDED.events_written END,
			blocked_count = CASE WHEN crawl_run_status.run_id IS NOT DISTINCT FROM EXCLUDED.run_id
			                   THEN crawl_run_status.blocked_count + EXCLUDED.blocked_count ELSE EXCLUDED.blocked_count END,
			rewarm_needed = CASE WHEN crawl_run_status.run_id IS NOT DISTINCT FROM EXCLUDED.run_id
			                   THEN crawl_run_status.rewarm_needed OR EXCLUDED.rewarm_needed ELSE EXCLUDED.rewarm_needed END,
			freshness_oldest_hours = CASE WHEN crawl_run_status.run_id IS NOT DISTINCT FROM EXCLUDED.run_id
			                   THEN crawl_run_status.freshness_oldest_hours ELSE NULL END,
			detail      = EXCLUDED.detail,
			updated_at  = now()`
	_, err := pool.Exec(ctx, q,
		rec.RunType, rec.Host, rec.RunID, rec.StartedAt, rec.Status,
		rec.SuburbsSelected, rec.SuburbsDone, rec.ListingsTouched, rec.EventsWritten,
		rec.BlockedCount, rec.RewarmNeeded, rec.Detail)
	return err
}

// updateCrawlRunFreshness annotates the current run-type/host row with the freshness
// guard's oldest-covered-suburb age (hours). It targets the row `-mode agent` just
// wrote for this launchd run (same run_type + host), so the dashboard can show
// staleness alongside the run's counts. A no-op UPDATE (0 rows) when no agent round
// has written a row yet is fine — freshness runs AFTER the drain in every wrapper.
func updateCrawlRunFreshness(ctx context.Context, pool *pgxpool.Pool, runType, host string, oldestHours float64) error {
	_, err := pool.Exec(ctx, `
		UPDATE crawl_run_status
		SET freshness_oldest_hours = $3, updated_at = now()
		WHERE run_type = $1 AND host = $2`,
		runType, host, oldestHours)
	return err
}

// writeCrawlRunStatus is the BEST-EFFORT wrapper used by the crawl paths: it upserts
// on a DETACHED context (so a run deadline firing can't kill the health write, same
// posture as the end-of-run MV refresh) and only logs on failure — the health record
// must never fail the crawl.
func writeCrawlRunStatus(rec crawlRunStatusRecord, pool *pgxpool.Pool) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := upsertCrawlRunStatus(ctx, pool, rec); err != nil {
		log.Printf("[agent] crawl_run_status upsert failed (best-effort): %v", err)
	}
}
