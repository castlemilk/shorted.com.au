package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// The collector refreshes the 000139 suburb reference views after the housing
// views, tolerates a database without 000139, and refreshes them after a
// Census or amenity load only when that load succeeded.
//
// Runs in a private schema it creates and drops, so any Postgres will do:
//
//	HOUSING_TEST_DB_URL='postgresql://admin:password@localhost:5438/shorts' \
//	  GOWORK=off go test -run TestSuburbReferenceRefresh_ -v .
//
// Skips when HOUSING_TEST_DB_URL is unset, so `make test` stays offline.
func openSuburbReferenceRefreshSchema(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dbURL := os.Getenv("HOUSING_TEST_DB_URL")
	if dbURL == "" {
		t.Skip("set HOUSING_TEST_DB_URL to a Postgres to run the suburb reference refresh test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	schema := fmt.Sprintf("suburb_ref_refresh_test_%d", time.Now().UnixNano())
	admin, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(admin.Close)
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatalf("create schema: %v", err)
	}
	t.Cleanup(func() { _, _ = admin.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE") })
	cfg, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatalf("connect (schema): %v", err)
	}
	t.Cleanup(pool.Close)
	if _, err := pool.Exec(ctx, `
		CREATE TABLE suburb_demographics (sal_code TEXT PRIMARY KEY, sal_name TEXT NOT NULL, state_code TEXT NOT NULL, population INT);
		CREATE TABLE house_price_regions (region_code TEXT PRIMARY KEY, region_type TEXT NOT NULL, region_name TEXT NOT NULL,
			state_code TEXT, postcode TEXT, sal_code TEXT);
		CREATE TABLE refresh_calls (n serial PRIMARY KEY, fn text NOT NULL);
		CREATE FUNCTION refresh_housing_materialized_views() RETURNS void LANGUAGE sql
			AS $$ INSERT INTO refresh_calls (fn) VALUES ('housing') $$;`); err != nil {
		t.Fatalf("schema: %v", err)
	}
	return pool
}

func refreshCalls(t *testing.T, pool *pgxpool.Pool) []string {
	t.Helper()
	rows, err := pool.Query(context.Background(), `SELECT fn FROM refresh_calls ORDER BY n`)
	if err != nil {
		t.Fatalf("read calls: %v", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var fn string
		if err := rows.Scan(&fn); err != nil {
			t.Fatalf("scan: %v", err)
		}
		out = append(out, fn)
	}
	return out
}

func TestSuburbReferenceRefresh_ToleratesADatabaseWithout000139(t *testing.T) {
	pool := openSuburbReferenceRefreshSchema(t)
	ctx := context.Background()

	if err := refreshSuburbReferenceViews(ctx, pool); err != nil {
		t.Fatalf("a missing refresh_suburb_reference_views() must be a skipped step, got %v", err)
	}
	if err := refresh(ctx, pool); err != nil {
		t.Fatalf("refresh() must still succeed without 000139: %v", err)
	}
	if got := refreshCalls(t, pool); len(got) != 1 || got[0] != "housing" {
		t.Fatalf("calls %v: the housing views still refresh", got)
	}
}

func TestSuburbReferenceRefresh_RunsAfterTheHousingViews(t *testing.T) {
	pool := openSuburbReferenceRefreshSchema(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `
		CREATE FUNCTION refresh_suburb_reference_views() RETURNS void LANGUAGE sql
			AS $$ INSERT INTO refresh_calls (fn) VALUES ('suburb_reference') $$;`); err != nil {
		t.Fatalf("stub: %v", err)
	}

	if err := refresh(ctx, pool); err != nil {
		t.Fatalf("refresh: %v", err)
	}
	got := refreshCalls(t, pool)
	if len(got) != 2 || got[0] != "housing" || got[1] != "suburb_reference" {
		t.Fatalf("calls %v: want the housing views first, then the suburb reference views", got)
	}

	// A Census or amenity load refreshes them only when it succeeded.
	if err := afterSuburbReferenceIngest(ctx, pool, nil); err != nil {
		t.Fatalf("after a successful ingest: %v", err)
	}
	ingestErr := errors.New("census download failed")
	if err := afterSuburbReferenceIngest(ctx, pool, ingestErr); !errors.Is(err, ingestErr) {
		t.Fatalf("a failed ingest must be returned as is, got %v", err)
	}
	if got := refreshCalls(t, pool); len(got) != 3 || got[2] != "suburb_reference" {
		t.Fatalf("calls %v: one more refresh for the successful ingest, none for the failed one", got)
	}
}
