package main

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
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
