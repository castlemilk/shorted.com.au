package economy

// upsertObservations against a real Postgres: an observation re-published
// unchanged is not rewritten, and a revised one is.
//
// ECONOMY_TEST_DATABASE_URL only, never DATABASE_URL: services/.env holds the
// production URL, and this test writes (in a throwaway schema).

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func newEconomyDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("ECONOMY_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set ECONOMY_TEST_DATABASE_URL (a local database, never prod) to run the observation upsert test")
	}
	if strings.Contains(url, "supabase") || strings.Contains(url, "pooler") {
		t.Fatalf("ECONOMY_TEST_DATABASE_URL points at a hosted database; this test writes")
	}
	ctx := context.Background()
	schema := fmt.Sprintf("economy_store_test_%d", time.Now().UnixNano())
	admin, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(admin.Close)
	if _, err := admin.Exec(ctx, `CREATE SCHEMA `+schema); err != nil {
		t.Fatalf("create schema: %v", err)
	}
	t.Cleanup(func() { _, _ = admin.Exec(context.Background(), `DROP SCHEMA IF EXISTS `+schema+` CASCADE`) })

	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema + ", public"
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatalf("connect (schema): %v", err)
	}
	t.Cleanup(pool.Close)
	// The package directory, which `go test` runs in (runtime.Caller reports an
	// import path under the machine-wide -trimpath).
	for _, m := range []string{"000081_add_economic_series.up.sql", "000121_economic_series_internal_only.up.sql"} {
		sql, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "migrations", m))
		if err != nil {
			t.Fatalf("read %s: %v", m, err)
		}
		if _, err := pool.Exec(ctx, string(sql)); err != nil {
			t.Fatalf("apply %s: %v", m, err)
		}
	}
	return pool
}

func TestUpsertObservationsLeavesUnchangedObservationsAlone(t *testing.T) {
	pool := newEconomyDB(t)
	ctx := context.Background()

	def := SeriesDef{Topic: "prices", Metric: "cpi", RegionType: "national", RegionCode: "aus", RegionName: "Australia",
		Unit: "index", Frequency: "quarterly", Adjustment: "original", SourceKey: "abs-cpi", Licence: "CC-BY-4.0"}
	q := func(y int, m time.Month) time.Time { return time.Date(y, m, 1, 0, 0, 0, 0, time.UTC) }
	obs := []Obs{{Series: def, Period: q(2026, 3), Value: 140.1}, {Series: def, Period: q(2026, 6), Value: 141.25}}
	if n, err := upsertObservations(ctx, pool, obs); err != nil || n != 2 {
		t.Fatalf("first upsert: n=%d err=%v", n, err)
	}
	versions := func() map[string]string {
		rows, err := pool.Query(ctx, `SELECT period::text, xmin::text FROM economic_observations ORDER BY period`)
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		defer rows.Close()
		out := map[string]string{}
		for rows.Next() {
			var p, x string
			if err := rows.Scan(&p, &x); err != nil {
				t.Fatalf("scan: %v", err)
			}
			out[p] = x
		}
		return out
	}
	before := versions()

	if n, err := upsertObservations(ctx, pool, obs); err != nil || n != 2 {
		t.Fatalf("re-upsert: n=%d err=%v (n counts observations sent)", n, err)
	}
	if after := versions(); fmt.Sprint(after) != fmt.Sprint(before) {
		t.Fatalf("an unchanged observation was rewritten:\nbefore %v\nafter  %v", before, after)
	}

	obs[1].Value = 141.5 // a revision
	if _, err := upsertObservations(ctx, pool, obs); err != nil {
		t.Fatalf("revised upsert: %v", err)
	}
	after := versions()
	if after["2026-03-01"] != before["2026-03-01"] || after["2026-06-01"] == before["2026-06-01"] {
		t.Fatalf("only the revised quarter may be rewritten: before %v after %v", before, after)
	}
	var v float64
	if err := pool.QueryRow(ctx, `SELECT value FROM economic_observations WHERE period = '2026-06-01'`).Scan(&v); err != nil || v != 141.5 {
		t.Fatalf("revised value = %v, %v", v, err)
	}
}
