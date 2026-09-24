package main

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Migration 000128 re-points stripped-pass SAL links to linkStrippedSalSQL's
// populous pick, but only where the region's postcode does not contradict the
// move. It runs here, verbatim, in a private schema seeded with each case it
// must move and each case it must hold, and then again to prove a replay is a
// no-op.
//
//	HOUSING_TEST_DB_URL='postgresql://admin:password@localhost:5438/shorts' \
//	  GOWORK=off go test -run TestRepointStrippedSalLinks_ -v .
func TestRepointStrippedSalLinks_Migration_Integration(t *testing.T) {
	dbURL := os.Getenv("HOUSING_TEST_DB_URL")
	if dbURL == "" {
		t.Skip("set HOUSING_TEST_DB_URL to a Postgres to run the 000128 migration test")
	}
	migration, err := os.ReadFile("../migrations/000128_repoint_stripped_sal_links.up.sql")
	if err != nil {
		t.Fatalf("read 000128: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	schema := fmt.Sprintf("sal_repoint_test_%d", time.Now().UnixNano())
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
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	// The prod apply path is psql over the session pooler: one simple-protocol
	// script. Simple protocol runs the file's BEGIN ... COMMIT as written.
	cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
	cfg.MaxConns = 1
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()

	if _, err := pool.Exec(ctx, `
		CREATE TABLE suburb_demographics (sal_code text PRIMARY KEY, sal_name text NOT NULL, state_code text NOT NULL, population int);
		CREATE TABLE suburb_lga (sal_code text PRIMARY KEY, lga_code24 text NOT NULL);
		CREATE TABLE house_price_regions (region_code text PRIMARY KEY, region_type text NOT NULL, region_name text NOT NULL,
			state_code text, postcode text, sal_code text);
		CREATE TABLE property_listings (id bigint PRIMARY KEY, region_code text, sal_code text);
		CREATE TABLE property_price_events (id bigint PRIMARY KEY, listing_pk bigint, sal_code text);
		CREATE TABLE housing_drop_index_daily (snapshot_date date, grain text, grain_key text, active_addresses int,
			PRIMARY KEY (snapshot_date, grain, grain_key));

		INSERT INTO suburb_demographics VALUES
			-- Mayfield: wrongly on the hamlet; a 2304 postcode-mate sits in Newcastle.
			('M1', 'Mayfield (Shoalhaven - NSW)', 'NSW', 36),
			('M2', 'Mayfield (Newcastle - NSW)',  'NSW', 9760),
			('M3', 'Mayfield (Vic.)',             'VIC', 50000),
			('W1', 'Waratah',                     'NSW', 5000),
			-- Greenlands: correct on the smaller SAL; a 2631 mate sits in Snowy Monaro.
			('G1', 'Greenlands (Snowy Monaro Regional - NSW)', 'NSW', 20),
			('G2', 'Greenlands (Singleton - NSW)',             'NSW', 102),
			('N1', 'Nimmitabel',                               'NSW', 300),
			-- Rosewood: no evidence either way and a near tie: held.
			('R1', 'Rosewood (Snowy Valleys - NSW)',           'NSW', 218),
			('R2', 'Rosewood (Port Macquarie-Hastings - NSW)', 'NSW', 221),
			-- Dural: no evidence, decisive population gap: moved.
			('D1', 'Dural (Singleton - NSW)', 'NSW', 0),
			('D2', 'Dural (Hornsby - NSW)',   'NSW', 7900),
			-- An exact-name link is never re-pointed, even with a populous twin.
			('B1', 'Bondi',                'NSW', 100),
			('B2', 'Bondi (Other - NSW)',  'NSW', 99999),
			-- A region whose exact name exists as a SAL is left alone.
			('A1', 'Abbotsford',                'NSW', 10),
			('A2', 'Abbotsford (Small - NSW)',   'NSW', 5),
			('A3', 'Abbotsford (Big - NSW)',     'NSW', 90000),
			-- A crawl region (postcode in its code) with listings, events and index rows.
			('S1', 'St Clair (Singleton - NSW)', 'NSW', 17),
			('S2', 'St Clair (Penrith - NSW)',   'NSW', 19942),
			-- Two crawl regions share the Tamworth Kingswood link: the Penrith one
			-- moves, the Tamworth one (a 2340 mate in Tamworth) stays, so the
			-- index rows keyed by that SAL cannot be attributed and stay put.
			('K1', 'Kingswood (Tamworth Regional - NSW)', 'NSW', 1142),
			('K2', 'Kingswood (Penrith - NSW)',           'NSW', 10633),
			('T1', 'Tamworth',                            'NSW', 40000);
		INSERT INTO suburb_lga VALUES
			('M1', 'SHOAL'), ('M2', 'NEWC'), ('W1', 'NEWC'),
			('G1', 'SNOWY'), ('G2', 'SINGL'), ('N1', 'SNOWY'),
			('R1', 'SNOWYV'), ('R2', 'PMQ'), ('D1', 'SINGL'), ('D2', 'HORNS'),
			('S1', 'SINGL'), ('S2', 'PENR'),
			('K1', 'TAMW'), ('K2', 'PENR'), ('T1', 'TAMW');
		INSERT INTO house_price_regions VALUES
			('SUBURB:NSW-MAYFIELD',       'suburb', 'Mayfield',   'NSW', '2304', 'M1'),
			('SUBURB:NSW-WARATAH',        'suburb', 'Waratah',    'NSW', '2304', 'W1'),
			('SUBURB:NSW-GREENLANDS',     'suburb', 'Greenlands', 'NSW', '2631', 'G1'),
			('SUBURB:NSW-NIMMITABEL',     'suburb', 'Nimmitabel', 'NSW', '2631', 'N1'),
			('SUBURB:NSW-ROSEWOOD',       'suburb', 'Rosewood',   'NSW', '2652', 'R1'),
			('SUBURB:NSW-DURAL',          'suburb', 'Dural',      'NSW', '2158', 'D1'),
			('SUBURB:NSW-BONDI',          'suburb', 'Bondi',      'NSW', '2026', 'B1'),
			('SUBURB:NSW-ABBOTSFORD',     'suburb', 'Abbotsford', 'NSW', '2046', 'A2'),
			('SUBURB:NSW-2759-ST-CLAIR',  'suburb', 'St Clair',   'NSW', '2759', 'S1'),
			('SUBURB:NSW-2747-KINGSWOOD', 'suburb', 'Kingswood',  'NSW', '2747', 'K1'),
			('SUBURB:NSW-2340-KINGSWOOD', 'suburb', 'Kingswood',  'NSW', '2340', 'K1'),
			('SUBURB:NSW-TAMWORTH',       'suburb', 'Tamworth',   'NSW', '2340', 'T1'),
			('GCCSA:1GSYD',               'gccsa',  'Mayfield',   'NSW', NULL,   'M1');
		INSERT INTO property_listings VALUES
			(1, 'SUBURB:NSW-2759-ST-CLAIR', 'S1'),
			(2, 'SUBURB:NSW-2759-ST-CLAIR', 'X9'),   -- a listing someone linked by hand: kept
			(3, 'SUBURB:NSW-BONDI',         'B1');
		INSERT INTO property_price_events VALUES (10, 1, 'S1'), (11, 2, 'X9'), (12, 3, 'B1');
		INSERT INTO housing_drop_index_daily VALUES
			('2026-09-01', 'suburb', 'S1', 5),
			('2026-09-02', 'suburb', 'S1', 6),
			('2026-09-02', 'suburb', 'S2', 7),     -- target already has this day: not re-keyed
			('2026-09-01', 'suburb', 'B1', 9),
			('2026-09-01', 'suburb', 'K1', 4);     -- K1 still has a region: not re-keyed`); err != nil {
		t.Fatalf("seed: %v", err)
	}

	type snapshot map[string]string
	read := func() snapshot {
		t.Helper()
		out := snapshot{}
		for _, q := range []string{
			`SELECT 'region:'||region_code, COALESCE(sal_code,'') FROM house_price_regions`,
			`SELECT 'listing:'||id, COALESCE(sal_code,'') FROM property_listings`,
			`SELECT 'event:'||id, COALESCE(sal_code,'') FROM property_price_events`,
			`SELECT 'index:'||snapshot_date||':'||active_addresses, grain_key FROM housing_drop_index_daily`,
		} {
			rows, err := pool.Query(ctx, q)
			if err != nil {
				t.Fatal(err)
			}
			for rows.Next() {
				var k, v string
				if err := rows.Scan(&k, &v); err != nil {
					t.Fatal(err)
				}
				out[k] = v
			}
			rows.Close()
		}
		return out
	}

	if _, err := pool.Exec(ctx, string(migration)); err != nil {
		t.Fatalf("apply 000128: %v", err)
	}
	got := read()
	want := snapshot{
		"region:SUBURB:NSW-MAYFIELD":       "M2", // moved: postcode mate in Newcastle, never the VIC one
		"region:SUBURB:NSW-WARATAH":        "W1",
		"region:SUBURB:NSW-GREENLANDS":     "G1", // held: postcode evidence backs the current link
		"region:SUBURB:NSW-NIMMITABEL":     "N1",
		"region:SUBURB:NSW-ROSEWOOD":       "R1", // held: no evidence and a near tie
		"region:SUBURB:NSW-DURAL":          "D2", // moved: no evidence, decisive
		"region:SUBURB:NSW-BONDI":          "B1", // exact-name link: never re-pointed
		"region:SUBURB:NSW-ABBOTSFORD":     "A2", // its exact name is a SAL: left alone
		"region:SUBURB:NSW-2759-ST-CLAIR":  "S2",
		"region:GCCSA:1GSYD":               "M1", // not a suburb region
		"listing:1":                        "S2", // crawl copy of the old link moves with it
		"listing:2":                        "X9",
		"listing:3":                        "B1",
		"event:10":                         "S2",
		"event:11":                         "X9",
		"event:12":                         "B1",
		"index:2026-09-01:5":               "S2", // re-keyed: the old SAL has no region left
		"index:2026-09-02:6":               "S1", // the new key already has that day
		"index:2026-09-02:7":               "S2",
		"index:2026-09-01:9":               "B1",
		"region:SUBURB:NSW-2747-KINGSWOOD": "K2", // no evidence, decisive
		"region:SUBURB:NSW-2340-KINGSWOOD": "K1", // postcode mate in Tamworth
		"index:2026-09-01:4":               "K1",
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %q, want %q", k, got[k], v)
		}
	}

	// A replay moves nothing.
	if _, err := pool.Exec(ctx, string(migration)); err != nil {
		t.Fatalf("replay 000128: %v", err)
	}
	for k, v := range read() {
		if got[k] != v {
			t.Errorf("replay changed %s: %q -> %q", k, got[k], v)
		}
	}
}
