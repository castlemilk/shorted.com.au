package main

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// A VG suburb name that ABS repeats must link to the populous SAL, not to
// whichever row the planner meets first. Prod linked the NSW VG "Mayfield"
// series to Mayfield (Shoalhaven - NSW), 36 people, instead of Mayfield
// (Newcastle - NSW), 9,760 — so the populous suburb read as unpriced and the
// hamlet showed Newcastle's median. The insert order below puts the hamlet
// first, which is what an arbitrary pick tends to return.
//
// Runs in a private schema it creates and drops, so any Postgres will do:
//
//	HOUSING_TEST_DB_URL='postgresql://admin:password@localhost:5438/shorts' \
//	  GOWORK=off go test -run TestLinkSuburbSalCodes_ -v .
//
// Skips when HOUSING_TEST_DB_URL is unset, so `make test` stays offline.
func TestLinkSuburbSalCodes_RepeatedNamePicksPopulousSAL_Integration(t *testing.T) {
	dbURL := os.Getenv("HOUSING_TEST_DB_URL")
	if dbURL == "" {
		t.Skip("set HOUSING_TEST_DB_URL to a Postgres to run the SAL-link integration test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	schema := fmt.Sprintf("link_sal_test_%d", time.Now().UnixNano())
	admin, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer admin.Close()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatalf("create schema: %v", err)
	}
	defer func() { _, _ = admin.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE") }()

	cfg, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatalf("connect (schema): %v", err)
	}
	defer pool.Close()

	if _, err := pool.Exec(ctx, `
		CREATE TABLE suburb_demographics (sal_code TEXT PRIMARY KEY, sal_name TEXT NOT NULL, state_code TEXT NOT NULL, population INT);
		CREATE TABLE house_price_regions (region_code TEXT PRIMARY KEY, region_type TEXT NOT NULL, region_name TEXT NOT NULL,
			state_code TEXT, postcode TEXT, sal_code TEXT);
		INSERT INTO suburb_demographics VALUES
			('12543', 'Mayfield (Shoalhaven - NSW)', 'NSW', 36),
			('12544', 'Mayfield (Newcastle - NSW)',  'NSW', 9760),
			('12545', 'Mayfield (Oberon - NSW)',     'NSW', NULL),
			('20001', 'Mayfield (Vic.)',             'VIC', 50000),
			('11332', 'Dural (Singleton - NSW)',     'NSW', 0),
			('11333', 'Dural (Hornsby - NSW)',       'NSW', 7900),
			('11334', 'Dural (Lake Macquarie - NSW)','NSW', 7900),
			('10001', 'Bondi',                       'NSW', 10411);
		INSERT INTO house_price_regions VALUES
			('SUBURB:NSW-MAYFIELD', 'suburb', 'Mayfield', 'NSW', '2304', NULL),
			('SUBURB:NSW-DURAL',    'suburb', 'Dural',    'NSW', '2158', NULL),
			('SUBURB:NSW-BONDI',    'suburb', 'BONDI',    'NSW', '2026', NULL),
			('SUBURB:NSW-KEPT',     'suburb', 'Mayfield', 'NSW', '2304', '12543');`); err != nil {
		t.Fatalf("seed: %v", err)
	}

	n, err := linkSuburbSalCodes(ctx, pool)
	if err != nil {
		t.Fatalf("link: %v", err)
	}
	if n != 3 {
		t.Errorf("linked %d regions, want 3 (the already-linked row is left alone)", n)
	}
	want := map[string]string{
		"SUBURB:NSW-MAYFIELD": "12544", // most populous NSW Mayfield, never the VIC one
		"SUBURB:NSW-DURAL":    "11333", // population tie → lowest sal_code, so a re-run is stable
		"SUBURB:NSW-BONDI":    "10001", // exact pass
		"SUBURB:NSW-KEPT":     "12543", // idempotent: a linked row is never relinked
	}
	for region, sal := range want {
		var got *string
		if err := pool.QueryRow(ctx, `SELECT sal_code FROM house_price_regions WHERE region_code = $1`, region).Scan(&got); err != nil {
			t.Fatalf("read %s: %v", region, err)
		}
		if got == nil {
			t.Errorf("%s left unlinked, want %s", region, sal)
		} else if *got != sal {
			t.Errorf("%s linked to %s, want %s", region, *got, sal)
		}
	}
}
