package main

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/castlemilk/shorted.com.au/services/pkg/testpostgres"
)

// The drop-index queries are asserted elsewhere with string matching, which
// CANNOT tell you whether SQL is valid. That gap shipped a real defect: the
// capitulation query's final SELECT had no `FROM delist_relist`, so every run
// died with `column "listing_pk" does not exist`, the backfill aborted, and the
// panel kept serving the previous metric's numbers. Every string assertion
// passed on that query.
//
// These tests PREPARE each query against a live Postgres. Preparing is enough —
// it forces the planner to resolve every column and CTE reference without
// needing housing data present, so it catches malformed SQL on any database
// that merely has the schema.
//
// Run with a throwaway DB, matching the convention in
// crawl_run_status_integration_test.go:
//
//	HOUSING_TEST_DB_URL='postgres://…' go test ./house-price-collector/ -run _Integration -v
//
// Skips when HOUSING_TEST_DB_URL is unset, so `make test` stays offline.
func TestDropIndexQueriesAreValidSQL_Integration(t *testing.T) {
	dbURL := os.Getenv("HOUSING_TEST_DB_URL")
	if dbURL == "" {
		t.Skip("set HOUSING_TEST_DB_URL to a Postgres with the housing schema to validate the drop-index SQL")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer pool.Close()

	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	defer conn.Release()

	for name, sql := range map[string]string{
		"suburbDaysSQL":       suburbDaysSQL(),
		"capitulationSQL":     capitulationSQL(),
		"upsertIndexPointSQL": upsertIndexPointSQL(),
	} {
		if _, err := conn.Conn().Prepare(ctx, name, sql); err != nil {
			t.Errorf("%s is not valid SQL: %v\n\n%s", name, err, sql)
		}
	}
}

// TestCapitulationExcludesStaleDelistEvents_Integration executes capitulationSQL on
// seeded delist and relist events, so the counts are checked, not just the query text.
// Four listings, the day is 2026-10-31, the window 30 days and the relist gap 7 days:
//
//   - A: delisted 10 Oct, last seen 1 Sep (stale), relisted 30 Oct. Excluded from both.
//   - B: delisted 9 Oct, last seen 25 Sep (recent), relisted 30 Oct. Counted in both.
//   - C: delisted 20 Oct, last seen 10 Sep (stale), never relisted. Excluded.
//   - D: delisted 20 Oct, last seen 18 Oct (recent), never relisted. Counted.
//
// Expected: withdrawn_then_relisted 1 (B), delisted_count 2 (B, D). Without the stale
// exclusion it is 2 and 4.
//
// It uses a throwaway database, as the other housing integration tests do, and runs only
// with HOUSING_TEST_DB_URL or HOUSING_TESTCONTAINERS=1 (-tags=testcontainers).
func TestCapitulationExcludesStaleDelistEvents_Integration(t *testing.T) {
	dsn, err := testpostgres.Admin("HOUSING_TEST_DB_URL", "HOUSING_TESTCONTAINERS")
	if err != nil {
		t.Fatalf("start the test Postgres: %v", err)
	}
	if dsn == "" {
		t.Skip("set HOUSING_TEST_DB_URL, or HOUSING_TESTCONTAINERS=1 with -tags=testcontainers, to run the capitulation test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer pool.Close()

	if _, err := pool.Exec(ctx, `
		DROP TABLE IF EXISTS property_price_events;
		DROP TABLE IF EXISTS property_listings;
		CREATE TABLE property_listings (id BIGINT PRIMARY KEY, last_seen_at TIMESTAMPTZ NOT NULL);
		CREATE TABLE property_price_events (
		  id BIGSERIAL PRIMARY KEY, listing_pk BIGINT NOT NULL,
		  event_type TEXT NOT NULL, observed_at TIMESTAMPTZ NOT NULL);
		INSERT INTO property_listings (id, last_seen_at) VALUES
		  (1, '2026-09-01T00:00:00Z'), (2, '2026-09-25T00:00:00Z'),
		  (3, '2026-09-10T00:00:00Z'), (4, '2026-10-18T00:00:00Z');
		INSERT INTO property_price_events (listing_pk, event_type, observed_at) VALUES
		  (1, 'delisted', '2026-10-10T12:00:00Z'), (1, 'relisted', '2026-10-30T12:00:00Z'),
		  (2, 'delisted', '2026-10-09T12:00:00Z'), (2, 'relisted', '2026-10-30T12:00:00Z'),
		  (3, 'delisted', '2026-10-20T12:00:00Z'),
		  (4, 'delisted', '2026-10-20T12:00:00Z');`); err != nil {
		t.Fatalf("seed: %v", err)
	}

	var withdrawnThenRelisted, delistedCount int
	if err := pool.QueryRow(ctx, capitulationSQL(),
		time.Date(2026, 10, 31, 0, 0, 0, 0, time.UTC), indexWindowDays, indexRelistGapDays, indexDelistStaleDays,
	).Scan(&withdrawnThenRelisted, &delistedCount); err != nil {
		t.Fatalf("run capitulationSQL: %v", err)
	}
	if withdrawnThenRelisted != 1 {
		t.Errorf("withdrawn_then_relisted = %d, want 1 (only B: A is stale)", withdrawnThenRelisted)
	}
	if delistedCount != 2 {
		t.Errorf("delisted_count = %d, want 2 (B and D: A and C are stale)", delistedCount)
	}
}
