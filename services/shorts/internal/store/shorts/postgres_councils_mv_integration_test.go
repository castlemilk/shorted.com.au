//go:build integration

package shorts

import (
	"context"
	"fmt"
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// mv_council_price_drops must return exactly what the live query returns, and
// the store must fall back to the live query where the view is absent. Runs in
// a private schema it creates and drops (the only writes), seeded relative to
// now() so every window in the query is exercised:
//
//	cd services && GOWORK=off go test -tags integration -run TestCouncilDropsMV ./shorts/internal/store/shorts/ -v
func TestCouncilDropsMVEqualsLiveQueryAndFallsBack(t *testing.T) {
	dsn := os.Getenv("SHORTS_TEST_DATABASE_URL")
	if dsn == "" {
		dsn = "postgresql://admin:password@localhost:5438/shorts"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	admin, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Skipf("database unavailable: %v", err)
	}
	defer admin.Close()
	if err := admin.Ping(ctx); err != nil {
		t.Skipf("database unavailable: %v", err)
	}
	schema := fmt.Sprintf("council_drops_mv_test_%d", time.Now().UnixNano())
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatalf("create schema: %v", err)
	}
	defer func() { _, _ = admin.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE") }()

	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()

	// L1 has S1 (four cut addresses) and S2 (one cut of two addresses); L2 has
	// S3 (one cut). Excluded by the query: a listing unseen for 20 days, a 50%
	// cut, a 40-day-old cut, an inactive listing, a blank address. One address
	// is listed by two portals and must count once.
	if _, err := pool.Exec(ctx, `
		CREATE TABLE lga (lga_code24 text PRIMARY KEY, state_code text);
		CREATE TABLE suburb_lga (sal_code text PRIMARY KEY, lga_code24 text);
		CREATE TABLE house_price_regions (region_code text PRIMARY KEY, sal_code text);
		CREATE TABLE suburb_demographics (sal_code text PRIMARY KEY, sal_name text, postcode text);
		CREATE TABLE property_listings (id bigint PRIMARY KEY, region_code text, is_active boolean,
			last_seen_at timestamptz, address_key text);
		CREATE TABLE property_price_events (listing_pk bigint, source text, event_type text,
			observed_at timestamptz, drop_pct double precision, drop_abs double precision);
		CREATE TABLE housing_mv_refresh (mv_name text PRIMARY KEY, refreshed_at timestamptz NOT NULL, data_through timestamptz);
		INSERT INTO lga VALUES ('L1', 'NSW'), ('L2', 'NSW'), ('V1', 'VIC');
		INSERT INTO suburb_lga VALUES ('S1', 'L1'), ('S2', 'L1'), ('S3', 'L2'), ('S9', 'V1');
		INSERT INTO house_price_regions VALUES ('R1', 'S1'), ('R2', 'S2'), ('R3', 'S3'), ('R9', 'S9');
		INSERT INTO suburb_demographics VALUES ('S1', 'One', '2001'), ('S2', 'Two', '2002'), ('S3', 'Three', '2003');
		INSERT INTO property_listings VALUES
			(1, 'R1', true, now() - interval '1 day', 'a1'),
			(2, 'R1', true, now() - interval '1 day', 'a2'),
			(3, 'R1', true, now() - interval '2 days', 'a3'),
			(4, 'R1', true, now() - interval '3 days', 'a4'),
			(5, 'R1', true, now() - interval '3 days', 'a4'),   -- same address, other portal
			(6, 'R1', true, now() - interval '20 days', 'a6'),  -- unseen: not active
			(7, 'R1', false, now() - interval '1 day', 'a7'),   -- inactive
			(8, 'R1', true, now() - interval '1 day', ''),      -- no address unit
			(9, 'R2', true, now() - interval '1 day', 'b1'),
			(10, 'R2', true, now() - interval '1 day', 'b2'),
			(11, 'R2', true, now() - interval '1 day', 'b3'),   -- 50% cut: over the cap
			(12, 'R2', true, now() - interval '1 day', 'b4'),   -- cut 40 days ago
			(13, 'R3', true, now() - interval '1 day', 'c1'),
			(14, 'R9', true, now() - interval '1 day', 'v1');
		INSERT INTO property_price_events VALUES
			(1, 'rea', 'price_drop', now() - interval '2 days', 0.05, 50000),
			(2, 'rea', 'price_drop', now() - interval '2 days', 0.10, 90000),
			(3, 'rea', 'price_drop', now() - interval '5 days', 0.02, 20000),
			(4, 'rea', 'price_drop', now() - interval '5 days', 0.03, 30000),
			(5, 'domain', 'price_drop', now() - interval '4 days', 0.08, 80000),
			(6, 'rea', 'price_drop', now() - interval '2 days', 0.20, 1),
			(7, 'rea', 'price_drop', now() - interval '2 days', 0.20, 1),
			(8, 'rea', 'price_drop', now() - interval '2 days', 0.20, 1),
			(9, 'rea', 'price_drop', now() - interval '1 day', 0.04, 40000),
			(11, 'rea', 'price_drop', now() - interval '1 day', 0.50, 500000),
			(12, 'rea', 'price_drop', now() - interval '40 days', 0.06, 60000),
			(13, 'rea', 'price_drop', now() - interval '1 day', 0.07, 70000),
			(14, 'rea', 'price_drop', now() - interval '1 day', 0.07, 70000),
			(1, 'rea', 'relisted', now() - interval '1 day', NULL, NULL);`); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if _, err := pool.Exec(ctx, "CREATE MATERIALIZED VIEW mv_council_price_drops AS "+councilDropsMVBody(t)); err != nil {
		t.Fatalf("create view from 000127: %v", err)
	}
	refreshed := time.Now().Add(-time.Minute).UTC().Truncate(time.Microsecond)
	if _, err := pool.Exec(ctx, `INSERT INTO housing_mv_refresh VALUES ('mv_council_price_drops', $1, now())`, refreshed); err != nil {
		t.Fatal(err)
	}

	store := &postgresStore{db: pool}
	live, err := store.scanCouncilDrops(ctx, councilDropsQuery, "NSW", "", councilDropsMinCount)
	if err != nil {
		t.Fatalf("live query: %v", err)
	}
	viaMV, err := store.councilDrops(ctx, "NSW", "")
	if err != nil {
		t.Fatalf("view read: %v", err)
	}
	if len(live) != 2 || len(viaMV) != 2 {
		t.Fatalf("councils: live %d, view %d; want L1 and L2 only (V1 is VIC)", len(live), len(viaMV))
	}
	for code, l := range live {
		m := viaMV[code]
		if m == nil {
			t.Fatalf("%s missing from the view", code)
		}
		if !reflect.DeepEqual(stripDropTimes(*l), stripDropTimes(*m)) {
			t.Errorf("%s differs:\n live %+v\n view %+v", code, stripDropTimes(*l), stripDropTimes(*m))
		}
		if !m.AsOf.Equal(refreshed) {
			t.Errorf("%s as_of = %v, want the view's refresh %v", code, m.AsOf, refreshed)
		}
	}

	// The numbers themselves: S1 a1..a4 cut once each (a4 across two portals,
	// the larger total wins); S2 b1 only. Tracked counts active addressed
	// listings, including uncut ones, excluding the unseen/inactive/blank.
	l1 := viaMV["L1"]
	if l1.Total.Dropped != 5 || l1.Total.Tracked != 8 {
		t.Errorf("L1 total dropped/tracked = %d/%d, want 5/8", l1.Total.Dropped, l1.Total.Tracked)
	}
	bySal := map[string]CouncilDropSuburbRow{}
	for _, s := range l1.Suburbs {
		bySal[s.SALCode] = s
	}
	if s := bySal["S1"]; s.Dropped != 4 || s.Tracked != 4 || s.MedianDropPct == nil || s.SALName != "One" {
		t.Errorf("S1 = %+v, want 4 of 4 with a median", s)
	} else if got := *s.MedianDropPct; got < 0.0649 || got > 0.0651 {
		// a1 .05, a2 .10, a3 .02, a4 .08 (domain's 80k beats rea's 30k) → median .065
		t.Errorf("S1 median = %v, want 0.065", got)
	}
	if s := bySal["S2"]; s.Dropped != 1 || s.Tracked != 4 || s.MedianDropPct != nil {
		t.Errorf("S2 = %+v, want 1 of 4 with the median withheld under 3 cuts", s)
	}
	if agg := aggregateCouncilDrops(viaMV["L2"]); agg != nil {
		t.Errorf("L2 has one cut; the council floor must publish nothing, got %+v", agg)
	}
	if agg := aggregateCouncilDrops(l1); agg == nil || len(agg.Suburbs) != 1 || agg.Suburbs[0].SALCode != "S1" {
		t.Errorf("L1 aggregate = %+v, want a share naming only S1", agg)
	}

	// One council.
	one, err := store.councilDrops(ctx, "NSW", "L2")
	if err != nil || len(one) != 1 || one["L2"] == nil {
		t.Fatalf("council filter = %v / %v, want L2 only", one, err)
	}

	// No refresh stamp: nothing dated, so nothing published.
	if _, err := pool.Exec(ctx, `DELETE FROM housing_mv_refresh`); err != nil {
		t.Fatal(err)
	}
	if got, err := store.councilDrops(ctx, "NSW", ""); err != nil || len(got) != 0 {
		t.Fatalf("undated view = %v / %v, want no rows", got, err)
	}

	// No view (a database before 000127): the live query answers.
	if _, err := pool.Exec(ctx, `DROP MATERIALIZED VIEW mv_council_price_drops`); err != nil {
		t.Fatal(err)
	}
	fallback, err := store.councilDrops(ctx, "NSW", "")
	if err != nil {
		t.Fatalf("fallback: %v", err)
	}
	for code, l := range live {
		if f := fallback[code]; f == nil || !reflect.DeepEqual(stripDropTimes(*l), stripDropTimes(*f)) {
			t.Errorf("%s fallback differs from the live query", code)
		}
	}
}

// stripDropTimes zeroes the times that legitimately differ between two reads
// (as_of is when each was computed); DataThrough is data and must match.
func stripDropTimes(c councilDrops) councilDrops {
	c.AsOf = time.Time{}
	c.Total.DataThrough = normalizeTime(c.Total.DataThrough)
	subs := make([]CouncilDropSuburbRow, len(c.Suburbs))
	for i, s := range c.Suburbs {
		s.DataThrough = normalizeTime(s.DataThrough)
		subs[i] = s
	}
	c.Suburbs = subs
	return c
}

func normalizeTime(t *time.Time) *time.Time {
	if t == nil {
		return nil
	}
	u := t.UTC()
	return &u
}
