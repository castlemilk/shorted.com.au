package main

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
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
	pool, _ := openSuburbReferenceRefreshSchemaPools(t)
	return pool
}

// openSuburbReferenceRefreshSchemaPools returns the collector's pool on a
// fresh private schema and a constructor for more pools on the same schema,
// each with extra runtime parameters.
func openSuburbReferenceRefreshSchemaPools(t *testing.T) (*pgxpool.Pool, func(params map[string]string) *pgxpool.Pool) {
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
	open := func(params map[string]string) *pgxpool.Pool {
		t.Helper()
		cfg, err := pgxpool.ParseConfig(dbURL)
		if err != nil {
			t.Fatalf("parse: %v", err)
		}
		// The collector's own protocol (connect, store.go).
		cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
		cfg.ConnConfig.RuntimeParams["search_path"] = schema
		maps.Copy(cfg.ConnConfig.RuntimeParams, params)
		pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
		if err != nil {
			t.Fatalf("connect (schema): %v", err)
		}
		t.Cleanup(pool.Close)
		return pool
	}
	pool := open(nil)
	// The columns 000139's view bodies read, plus what linkSuburbSalCodes reads.
	if _, err := pool.Exec(ctx, `
		CREATE TABLE suburb_demographics (sal_code TEXT PRIMARY KEY, sal_name TEXT NOT NULL, state_code TEXT NOT NULL, population INT,
			median_age NUMERIC, median_weekly_hhd_income NUMERIC, pct_born_overseas NUMERIC, dwelling_count INT,
			pct_owned_outright NUMERIC, pct_owned_mortgage NUMERIC, pct_rented NUMERIC, pct_separate_house NUMERIC,
			pct_flat_apartment NUMERIC, pct_couple_with_children NUMERIC, pct_lone_person_household NUMERIC,
			unemployment_rate NUMERIC, labour_force_participation_rate NUMERIC, pct_bachelor_or_higher NUMERIC,
			pct_low_personal_income NUMERIC, pct_high_personal_income NUMERIC);
		CREATE TABLE suburb_amenities (sal_code TEXT PRIMARY KEY, amenity_density_score NUMERIC, dist_to_coast_km NUMERIC);
		CREATE TABLE house_price_regions (region_code TEXT PRIMARY KEY, region_type TEXT NOT NULL, region_name TEXT NOT NULL,
			state_code TEXT, postcode TEXT, sal_code TEXT);
		CREATE TABLE house_prices (region_code TEXT NOT NULL, measure TEXT NOT NULL, dwelling_type TEXT NOT NULL,
			period DATE NOT NULL, value NUMERIC, source_licence TEXT NOT NULL DEFAULT 'CC-BY-4.0');
		CREATE TABLE refresh_calls (n serial PRIMARY KEY, fn text NOT NULL);
		CREATE FUNCTION refresh_housing_materialized_views() RETURNS void LANGUAGE sql
			AS $$ INSERT INTO refresh_calls (fn) VALUES ('housing') $$;`); err != nil {
		t.Fatalf("schema: %v", err)
	}
	return pool, open
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
	// 000139's signature: the skipped views, empty when all three refreshed.
	if _, err := pool.Exec(ctx, `
		CREATE FUNCTION refresh_suburb_reference_views() RETURNS text[] LANGUAGE sql
			AS $$ INSERT INTO refresh_calls (fn) VALUES ('suburb_reference'); SELECT ARRAY[]::text[] $$;`); err != nil {
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

// The function turns a view it cannot refresh into a WARNING, which the
// collector's pool never sees, and returns it. A skipped view fails the run,
// after the housing views refreshed, and the error names the view and why.
func TestSuburbReferenceRefresh_ASkippedViewFailsTheRun(t *testing.T) {
	pool := openSuburbReferenceRefreshSchema(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `
		CREATE FUNCTION refresh_suburb_reference_views() RETURNS text[] LANGUAGE plpgsql AS $$
		BEGIN
			INSERT INTO refresh_calls (fn) VALUES ('suburb_reference');
			RAISE WARNING 'Skipping mv_suburb_latest_price: canceling statement due to lock timeout';
			RETURN ARRAY['mv_suburb_latest_price: canceling statement due to lock timeout'];
		END $$;`); err != nil {
		t.Fatalf("stub: %v", err)
	}

	err := refreshSuburbReferenceViews(ctx, pool)
	if err == nil || !strings.Contains(err.Error(), "mv_suburb_latest_price: canceling statement due to lock timeout") {
		t.Fatalf("a skipped view must fail the refresh and name the view and the reason, got %v", err)
	}
	if err := refresh(ctx, pool); err == nil || !strings.Contains(err.Error(), "skipped 1 view(s)") {
		t.Fatalf("refresh() must return the skipped view, got %v", err)
	}
	if got := refreshCalls(t, pool); len(got) != 3 || got[1] != "housing" || got[2] != "suburb_reference" {
		t.Fatalf("calls %v: refresh() still refreshes the housing views first", got)
	}
}

// End to end against the real 000139 file: the function refreshes all three
// views and returns none skipped; with one view locked, the other two still
// refresh and the locked one comes back to the collector, which fails.
func TestSuburbReferenceRefresh_TheRealFunctionReportsAViewItCouldNotRefresh(t *testing.T) {
	pool, open := openSuburbReferenceRefreshSchemaPools(t)
	ctx := context.Background()
	migration, err := os.ReadFile("../migrations/000139_suburb_reference_mvs.up.sql")
	if err != nil {
		t.Fatalf("read 000139: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO suburb_demographics (sal_code, sal_name, state_code, population, median_age, median_weekly_hhd_income, pct_born_overseas, dwelling_count)
		VALUES ('10001', 'ALPHA', 'NSW', 5000, 38, 2000, 30, 1800), ('10002', 'BETA', 'NSW', 7000, 41, 1500, 20, 2600);
		INSERT INTO house_price_regions (region_code, region_type, region_name, state_code, sal_code)
		VALUES ('SUBURB:NSW-ALPHA', 'suburb', 'ALPHA', 'NSW', '10001');
		INSERT INTO house_prices (region_code, measure, dwelling_type, period, value)
		VALUES ('SUBURB:NSW-ALPHA', 'median_price', 'house', '2026-06-30', 1000000);`); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if _, err := pool.Exec(ctx, string(migration)); err != nil {
		t.Fatalf("apply 000139: %v", err)
	}
	if err := refreshSuburbReferenceViews(ctx, pool); err != nil {
		t.Fatalf("all three views refresh: %v", err)
	}

	// A new quarter, then a refresh that cannot lock mv_suburb_latest_price.
	if _, err := pool.Exec(ctx, `INSERT INTO house_prices (region_code, measure, dwelling_type, period, value)
		VALUES ('SUBURB:NSW-ALPHA', 'median_price', 'house', '2026-09-30', 1100000)`); err != nil {
		t.Fatalf("new quarter: %v", err)
	}
	holder, err := open(nil).Begin(ctx)
	if err != nil {
		t.Fatalf("begin holder: %v", err)
	}
	defer func() { _ = holder.Rollback(ctx) }()
	// LOCK TABLE refuses a materialized view; a refresh inside an open
	// transaction holds its ACCESS EXCLUSIVE lock until the rollback.
	if _, err := holder.Exec(ctx, `REFRESH MATERIALIZED VIEW mv_suburb_latest_price`); err != nil {
		t.Fatalf("lock: %v", err)
	}
	impatient := open(map[string]string{"lock_timeout": "200ms"})
	err = refreshSuburbReferenceViews(ctx, impatient)
	if err == nil || !strings.Contains(err.Error(), "skipped 1 view(s)") || !strings.Contains(err.Error(), "mv_suburb_latest_price: canceling statement due to lock timeout") {
		t.Fatalf("a view the function skipped must fail the refresh and name the view and the reason, got %v", err)
	}
	_ = holder.Rollback(ctx)

	var latest float64
	if err := pool.QueryRow(ctx, `SELECT value FROM mv_suburb_latest_price WHERE sal_code = '10001'`).Scan(&latest); err != nil {
		t.Fatalf("read view: %v", err)
	}
	if latest != 1000000 {
		t.Fatalf("mv_suburb_latest_price = %v: the skipped view must keep its previous data", latest)
	}
	var baselineMedian float64
	if err := pool.QueryRow(ctx, `SELECT state_median_price FROM mv_housing_state_baselines WHERE state_code = 'NSW'`).Scan(&baselineMedian); err != nil {
		t.Fatalf("read baselines: %v", err)
	}
	if baselineMedian != 1100000 {
		t.Fatalf("state_median_price = %v: the views not locked must still refresh", baselineMedian)
	}
}
