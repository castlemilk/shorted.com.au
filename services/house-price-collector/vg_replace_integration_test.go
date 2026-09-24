package main

import (
	"context"
	"fmt"
	"os"
	"sort"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// replaceTestPool opens a pool on a private schema with the two tables the
// replace touches, bound over the SIMPLE protocol the collector uses against
// the Supabase transaction pooler (arrays must bind there too).
//
//	HOUSING_TEST_DB_URL='postgresql://admin:password@localhost:5438/shorts' \
//	  GOWORK=off go test -run TestReplaceObservations_ -v .
func replaceTestPool(t *testing.T) (*pgxpool.Pool, context.Context) {
	t.Helper()
	dbURL := os.Getenv("HOUSING_TEST_DB_URL")
	if dbURL == "" {
		t.Skip("set HOUSING_TEST_DB_URL to a Postgres to run the VG replace integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)

	schema := fmt.Sprintf("vg_replace_test_%d", time.Now().UnixNano())
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
	cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatalf("connect (schema): %v", err)
	}
	t.Cleanup(pool.Close)

	if _, err := pool.Exec(ctx, `
		CREATE TABLE house_price_regions (region_code TEXT PRIMARY KEY);
		CREATE TABLE house_prices (
			id bigserial PRIMARY KEY,
			region_code text NOT NULL REFERENCES house_price_regions(region_code),
			measure text NOT NULL, dwelling_type text NOT NULL DEFAULT 'all',
			period date NOT NULL, period_freq text NOT NULL DEFAULT 'Q',
			value double precision NOT NULL, unit text,
			is_preliminary boolean NOT NULL DEFAULT false, source text NOT NULL,
			source_licence text NOT NULL DEFAULT 'CC-BY-4.0', content_hash text NOT NULL,
			fetched_at timestamptz NOT NULL DEFAULT now(),
			UNIQUE (region_code, measure, dwelling_type, period, source));
		INSERT INTO house_price_regions VALUES
			('SUBURB:NSW-BONDI'), ('SUBURB:NSW-ST LEONARDS'), ('SUBURB:NSW-RHODES'),
			('SUBURB:NSW-POINT PIPER'), ('SUBURB:VIC-FITZROY');
		-- The stored state before the run: three inflated whole-building medians the
		-- filtered parser no longer emits, plus rows the run must never touch.
		INSERT INTO house_prices (region_code, measure, dwelling_type, period, period_freq, value, source, content_hash) VALUES
			('SUBURB:NSW-BONDI',       'median_price',   'house', '2024-12-31', 'A', 4000000,   'vg_nsw', 'x'),
			('SUBURB:NSW-BONDI',       'median_price',   'house', '2025-12-31', 'A', 4100000,   'vg_nsw', 'x'),
			('SUBURB:NSW-ST LEONARDS', 'median_price',   'house', '2024-12-31', 'A', 110500000, 'vg_nsw', 'x'),
			('SUBURB:NSW-POINT PIPER', 'median_price',   'house', '2025-12-31', 'A', 60500000,  'vg_nsw', 'x'),
			('SUBURB:NSW-RHODES',      'median_price',   'house', '2023-12-31', 'A', 22500000,  'vg_nsw', 'x'),
			('SUBURB:NSW-ST LEONARDS', 'transfer_count', 'house', '2024-12-31', 'A', 3,         'vg_nsw', 'x'),
			('SUBURB:NSW-ST LEONARDS', 'median_price',   'unit',  '2024-12-31', 'A', 900000,    'vg_nsw', 'x'),
			('SUBURB:VIC-FITZROY',     'median_price',   'house', '2024-12-31', 'A', 1500000,   'vg_vic', 'x');`); err != nil {
		t.Fatalf("seed: %v", err)
	}
	return pool, ctx
}

func nswMedian(region string, year int, value float64) Observation {
	return Observation{
		RegionCode: region, Measure: "median_price", DwellingType: "house",
		Period: time.Date(year, 12, 31, 0, 0, 0, 0, time.UTC), PeriodFreq: "A",
		Value: value, Unit: "AUD", Source: nswSource, SourceLicence: nswLicence,
	}
}

func storedKeys(t *testing.T, ctx context.Context, pool *pgxpool.Pool) []string {
	t.Helper()
	rows, err := pool.Query(ctx, `SELECT source||'|'||measure||'|'||dwelling_type||'|'||region_code||'|'||to_char(period,'YYYY') FROM house_prices`)
	if err != nil {
		t.Fatal(err)
	}
	keys, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(keys)
	return keys
}

func TestReplaceObservations_PrunesOnlyTheAuthoritativeYears_Integration(t *testing.T) {
	pool, ctx := replaceTestPool(t)
	obs := []Observation{
		nswMedian("SUBURB:NSW-BONDI", 2024, 4200000),
		nswMedian("SUBURB:NSW-BONDI", 2025, 4300000),
	}
	// 2023 fetched thin, so it is not authoritative: Rhodes 2023 must survive.
	scope := replaceScope{Source: nswSource, Measure: "median_price", DwellingType: "house", PeriodFreq: "A", Years: []int{2024, 2025}}
	n, pruned, err := replaceObservations(ctx, pool, obs, scope)
	if err != nil {
		t.Fatalf("replace: %v", err)
	}
	if n != 2 {
		t.Errorf("upserted %d, want 2", n)
	}
	// In scope, 2024 holds Bondi + St Leonards and 2025 Bondi + Point Piper (the
	// unit and transfer-count rows are outside it), so each year is 1 stale of
	// 2 — over the 20% cap. Assert the cap first...
	if pruned != 0 {
		t.Fatalf("pruned %d rows from two-row years; the prune cap must hold them back", pruned)
	}

	// ...then a realistic year, where the stale rows are a small share.
	for i := 0; i < 20; i++ {
		region := fmt.Sprintf("SUBURB:NSW-FILLER%02d", i)
		if _, err := pool.Exec(ctx, `INSERT INTO house_price_regions VALUES ($1)`, region); err != nil {
			t.Fatal(err)
		}
		obs = append(obs, nswMedian(region, 2024, 1e6), nswMedian(region, 2025, 1e6))
	}
	n, pruned, err = replaceObservations(ctx, pool, obs, scope)
	if err != nil {
		t.Fatalf("replace: %v", err)
	}
	if n != 42 || pruned != 2 {
		t.Fatalf("upserted/pruned = %d/%d, want 42/2 (St Leonards 2024, Point Piper 2025)", n, pruned)
	}
	got := storedKeys(t, ctx, pool)
	for _, gone := range []string{
		"vg_nsw|median_price|house|SUBURB:NSW-ST LEONARDS|2024",
		"vg_nsw|median_price|house|SUBURB:NSW-POINT PIPER|2025",
	} {
		for _, k := range got {
			if k == gone {
				t.Errorf("%s survived the replace", gone)
			}
		}
	}
	for _, kept := range []string{
		"vg_nsw|median_price|house|SUBURB:NSW-RHODES|2023",        // non-authoritative year
		"vg_nsw|transfer_count|house|SUBURB:NSW-ST LEONARDS|2024", // another measure
		"vg_nsw|median_price|unit|SUBURB:NSW-ST LEONARDS|2024",    // another dwelling type
		"vg_vic|median_price|house|SUBURB:VIC-FITZROY|2024",       // another source
		"vg_nsw|median_price|house|SUBURB:NSW-BONDI|2025",         // re-emitted
	} {
		found := false
		for _, k := range got {
			found = found || k == kept
		}
		if !found {
			t.Errorf("%s was deleted; the prune must stay inside its scope", kept)
		}
	}
	var bondi float64
	if err := pool.QueryRow(ctx, `SELECT value FROM house_prices WHERE region_code='SUBURB:NSW-BONDI' AND period='2025-12-31' AND source='vg_nsw' AND measure='median_price'`).Scan(&bondi); err != nil || bondi != 4300000 {
		t.Fatalf("Bondi 2025 = %v (%v), want the upserted 4,300,000", bondi, err)
	}
}

func TestReplaceObservations_NoAuthoritativeYearIsAPlainUpsert_Integration(t *testing.T) {
	pool, ctx := replaceTestPool(t)
	before := storedKeys(t, ctx, pool)
	scope := replaceScope{Source: nswSource, Measure: "median_price", DwellingType: "house", PeriodFreq: "A"}
	n, pruned, err := replaceObservations(ctx, pool, []Observation{nswMedian("SUBURB:NSW-BONDI", 2025, 1)}, scope)
	if err != nil || n != 1 || pruned != 0 {
		t.Fatalf("replace = %d/%d/%v, want 1/0/nil", n, pruned, err)
	}
	if after := storedKeys(t, ctx, pool); len(after) != len(before) {
		t.Fatalf("rows %d -> %d; a scope with no years must delete nothing", len(before), len(after))
	}
}

func TestReplaceObservations_AFailedUpsertPrunesNothing_Integration(t *testing.T) {
	pool, ctx := replaceTestPool(t)
	before := storedKeys(t, ctx, pool)
	scope := replaceScope{Source: nswSource, Measure: "median_price", DwellingType: "house", PeriodFreq: "A", Years: []int{2023, 2024, 2025}}
	// An unknown region violates the FK mid-batch: the transaction rolls back,
	// so neither the good row nor any prune may land.
	obs := []Observation{nswMedian("SUBURB:NSW-BONDI", 2025, 1), nswMedian("SUBURB:NSW-NOWHERE", 2025, 1)}
	if _, _, err := replaceObservations(ctx, pool, obs, scope); err == nil {
		t.Fatal("replace with a dangling region succeeded")
	}
	after := storedKeys(t, ctx, pool)
	if len(after) != len(before) {
		t.Fatalf("rows %d -> %d after a failed replace", len(before), len(after))
	}
	var bondi float64
	if err := pool.QueryRow(ctx, `SELECT value FROM house_prices WHERE region_code='SUBURB:NSW-BONDI' AND period='2025-12-31' AND measure='median_price' AND dwelling_type='house'`).Scan(&bondi); err != nil || bondi != 4100000 {
		t.Fatalf("Bondi 2025 = %v (%v); the rolled-back upsert leaked", bondi, err)
	}
}
