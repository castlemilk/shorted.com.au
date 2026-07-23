package main

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// This integration test exercises the REAL upsert accumulation semantics of
// crawl_run_status (migration 000089) against a live Postgres: rounds sharing a
// run_id ACCUMULATE their counts into one row (keyed by run_type+host), a new run_id
// REPLACES the row and clears the previous freshness annotation, and the freshness
// UPDATE lands on the existing row.
//
// Run with a throwaway DB, e.g.:
//
//	docker run -d --name pg -e POSTGRES_PASSWORD=test -e POSTGRES_DB=sptest -p 55438:5432 postgres:16
//	HOUSING_TEST_DB_URL='postgres://postgres:test@localhost:55438/sptest' \
//	  go test ./house-price-collector/ -run TestCrawlRunStatusUpsert_Integration -v
//
// Skips when HOUSING_TEST_DB_URL is unset, so `make test` stays offline.
func TestCrawlRunStatusUpsert_Integration(t *testing.T) {
	dbURL := os.Getenv("HOUSING_TEST_DB_URL")
	if dbURL == "" {
		t.Skip("set HOUSING_TEST_DB_URL to a throwaway Postgres to run the crawl_run_status upsert integration test")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer pool.Close()

	// Minimal schema mirroring migration 000089.
	if _, err := pool.Exec(ctx, `
		DROP TABLE IF EXISTS crawl_run_status;
		CREATE TABLE crawl_run_status (
			run_type TEXT NOT NULL, host TEXT NOT NULL, run_id TEXT,
			started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ, status TEXT,
			suburbs_selected INT NOT NULL DEFAULT 0, suburbs_done INT NOT NULL DEFAULT 0,
			listings_touched INT NOT NULL DEFAULT 0, events_written INT NOT NULL DEFAULT 0,
			blocked_count INT NOT NULL DEFAULT 0, rewarm_needed BOOLEAN NOT NULL DEFAULT FALSE,
			freshness_oldest_hours NUMERIC, detail TEXT,
			updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			PRIMARY KEY (run_type, host));`); err != nil {
		t.Fatalf("create table: %v", err)
	}

	start := time.Now().UTC().Add(-2 * time.Hour)
	base := crawlRunStatusRecord{RunType: "delta", Host: "rig-x", RunID: "R1", StartedAt: start}

	// Round 1.
	r1 := base
	r1.Status, r1.SuburbsSelected, r1.SuburbsDone = "ok", 5, 4
	r1.ListingsTouched, r1.EventsWritten, r1.BlockedCount = 100, 10, 0
	r1.Detail = "round1"
	if err := upsertCrawlRunStatus(ctx, pool, r1); err != nil {
		t.Fatalf("round1 upsert: %v", err)
	}

	// Round 2 (SAME run_id) → accumulate.
	r2 := base
	r2.Status, r2.SuburbsSelected, r2.SuburbsDone = "partial", 3, 2
	r2.ListingsTouched, r2.EventsWritten, r2.BlockedCount = 40, 5, 1
	r2.Detail = "round2"
	if err := upsertCrawlRunStatus(ctx, pool, r2); err != nil {
		t.Fatalf("round2 upsert: %v", err)
	}

	got := readCrawlRow(ctx, t, pool, "delta", "rig-x")
	if got.selected != 8 || got.done != 6 || got.listings != 140 || got.events != 15 || got.blocked != 1 {
		t.Fatalf("accumulate mismatch: selected=%d done=%d listings=%d events=%d blocked=%d (want 8/6/140/15/1)",
			got.selected, got.done, got.listings, got.events, got.blocked)
	}
	if got.status != "partial" {
		t.Fatalf("status = %q, want latest round's 'partial'", got.status)
	}
	if got.detail != "round2" {
		t.Fatalf("detail = %q, want latest round's 'round2'", got.detail)
	}

	// Freshness annotation lands on the existing row.
	if err := updateCrawlRunFreshness(ctx, pool, "delta", "rig-x", 36.5); err != nil {
		t.Fatalf("freshness update: %v", err)
	}
	got = readCrawlRow(ctx, t, pool, "delta", "rig-x")
	if got.freshness == nil || *got.freshness < 36.4 || *got.freshness > 36.6 {
		t.Fatalf("freshness = %v, want ~36.5", got.freshness)
	}

	// Round 3 (NEW run_id) → replace + clear freshness.
	r3 := crawlRunStatusRecord{RunType: "delta", Host: "rig-x", RunID: "R2", StartedAt: time.Now().UTC()}
	r3.Status, r3.SuburbsSelected, r3.SuburbsDone = "ok", 2, 2
	r3.ListingsTouched, r3.EventsWritten = 7, 3
	if err := upsertCrawlRunStatus(ctx, pool, r3); err != nil {
		t.Fatalf("round3 upsert: %v", err)
	}
	got = readCrawlRow(ctx, t, pool, "delta", "rig-x")
	if got.selected != 2 || got.listings != 7 || got.events != 3 {
		t.Fatalf("replace mismatch: selected=%d listings=%d events=%d (want 2/7/3)", got.selected, got.listings, got.events)
	}
	if got.freshness != nil {
		t.Fatalf("freshness = %v, want NULL after a new-run replace", *got.freshness)
	}
}

type crawlRow struct {
	selected, done, listings, events, blocked int
	status, detail                            string
	freshness                                 *float64
}

func readCrawlRow(ctx context.Context, t *testing.T, pool *pgxpool.Pool, runType, host string) crawlRow {
	t.Helper()
	var r crawlRow
	err := pool.QueryRow(ctx, `
		SELECT suburbs_selected, suburbs_done, listings_touched, events_written, blocked_count,
			COALESCE(status,''), COALESCE(detail,''), freshness_oldest_hours
		FROM crawl_run_status WHERE run_type=$1 AND host=$2`, runType, host).
		Scan(&r.selected, &r.done, &r.listings, &r.events, &r.blocked, &r.status, &r.detail, &r.freshness)
	if err != nil {
		t.Fatalf("read row: %v", err)
	}
	return r
}
