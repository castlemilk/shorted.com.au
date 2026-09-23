//go:build integration

package shorts

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Runs against an EXISTING database that carries the council foundation data
// (000126 + `house-price-collector -mode lga`, erp-lga, ...). Read-only: it
// never creates, writes or refreshes anything, so it is safe on the shared
// local DB. Skips when the database or the council data is absent.
//
//	cd services && GOWORK=off go test -tags integration -run TestCouncilHub ./shorts/internal/store/shorts/ -v
func openCouncilHubDB(t *testing.T) *postgresStore {
	t.Helper()
	dsn := os.Getenv("SHORTS_TEST_DATABASE_URL")
	if dsn == "" {
		dsn = "postgresql://admin:password@localhost:5438/shorts"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Skipf("council hub database unavailable: %v", err)
	}
	t.Cleanup(pool.Close)
	var councils int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM lga WHERE kind = 'council' AND slug IS NOT NULL`).Scan(&councils); err != nil || councils == 0 {
		t.Skipf("council foundation data not loaded (%d councils, %v)", councils, err)
	}
	return &postgresStore{db: pool}
}

func TestCouncilHubListCouncils(t *testing.T) {
	store := openCouncilHubDB(t)
	for _, st := range []string{"NSW", "VIC", "QLD", "SA", "WA", "TAS", "NT", "ACT"} {
		start := time.Now()
		rows, err := store.ListCouncils(st)
		if err != nil {
			t.Fatalf("ListCouncils(%s): %v", st, err)
		}
		t.Logf("ListCouncils(%s): %d councils in %s", st, len(rows), time.Since(start).Round(time.Millisecond))
		if len(rows) == 0 {
			t.Errorf("ListCouncils(%s) is empty", st)
		}
		for _, r := range rows {
			if r.Kind != "council" && r.Kind != "unincorporated" {
				t.Errorf("%s: kind %q has no page", r.DisplayName, r.Kind)
			}
			if r.Slug == "" {
				t.Errorf("%s: no slug", r.DisplayName)
			}
			// No source covers flood planning outside NSW/VIC: absent, not 0.
			if (st == "QLD" || st == "WA") && r.FloodSharePct != nil {
				t.Errorf("%s (%s): flood share %v where no source covers it", r.DisplayName, st, *r.FloodSharePct)
			}
		}
	}
}

func TestCouncilHubProfiles(t *testing.T) {
	store := openCouncilHubDB(t)
	cases := []struct{ state, slug string }{
		{"QLD", "brisbane"}, {"NSW", "canterbury-bankstown"}, {"VIC", "yarra"},
		{"NSW", "broken-hill"}, {"ACT", "unincorporated-act"},
	}
	for _, c := range cases {
		start := time.Now()
		p, err := store.GetCouncilProfile(c.state, c.slug)
		if err != nil {
			t.Fatalf("GetCouncilProfile(%s/%s): %v", c.state, c.slug, err)
		}
		elapsed := time.Since(start).Round(time.Millisecond)
		if p.Summary == nil {
			t.Fatalf("%s: no summary row", c.slug)
		}
		t.Logf("%s/%s: %s kind=%s pop=%d suburbs=%d (dominant %d) series=%d neighbours=%d fed=%d state=%d drops=%v in %s",
			c.state, c.slug, p.Facts.DisplayName, p.Facts.Kind, p.Summary.Population, len(p.Suburbs),
			p.Rollup.DominantSuburbs, len(p.Series), len(p.Neighbours), len(p.FederalSeats), len(p.StateSeats),
			p.PriceDrops != nil, elapsed)
		if len(p.Suburbs) == 0 {
			t.Errorf("%s: no member suburbs", c.slug)
		}
		for _, s := range p.Suburbs {
			if !s.Dominant && s.Share < councilMemberMinShare {
				t.Errorf("%s: straddler %s at %.3f is below the member floor", c.slug, s.SALName, s.Share)
			}
		}
	}
	if _, err := store.GetCouncilProfile("NSW", "no-such-council"); !errors.Is(err, ErrCouncilNotFound) {
		t.Errorf("unknown slug: want ErrCouncilNotFound, got %v", err)
	}
	// A slug exists only within its own state.
	if _, err := store.GetCouncilProfile("VIC", "brisbane"); !errors.Is(err, ErrCouncilNotFound) {
		t.Errorf("wrong state: want ErrCouncilNotFound, got %v", err)
	}
}

// TestCouncilDropsQueryPoolsSubFloorSuburbs runs councilDropsQuery itself
// against fixtures. Every table it reads is shadowed by a TEMP table inside a
// transaction that is rolled back (pg_temp is searched first), so it needs no
// crawl data and writes nothing durable — safe on the shared local DB.
func TestCouncilDropsQueryPoolsSubFloorSuburbs(t *testing.T) {
	dsn := os.Getenv("SHORTS_TEST_DATABASE_URL")
	if dsn == "" {
		dsn = "postgresql://admin:password@localhost:5438/shorts"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Skipf("database unavailable: %v", err)
	}
	defer pool.Close()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Skipf("database unavailable: %v", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	fixtures := []string{
		`CREATE TEMP TABLE lga (lga_code24 text, state_code text) ON COMMIT DROP`,
		`CREATE TEMP TABLE suburb_lga (sal_code text, lga_code24 text) ON COMMIT DROP`,
		`CREATE TEMP TABLE house_price_regions (region_code text, sal_code text) ON COMMIT DROP`,
		`CREATE TEMP TABLE suburb_demographics (sal_code text, sal_name text, postcode text) ON COMMIT DROP`,
		`CREATE TEMP TABLE property_listings (id bigint, region_code text, is_active boolean,
			last_seen_at timestamptz, address_key text) ON COMMIT DROP`,
		`CREATE TEMP TABLE property_price_events (listing_pk bigint, event_type text, observed_at timestamptz,
			drop_pct double precision, drop_abs double precision, source text) ON COMMIT DROP`,
		`INSERT INTO lga VALUES ('A', 'NSW'), ('B', 'NSW')`,
		// Council A: s1 and s2 have 2 cuts each (under the per-suburb floor,
		// so mv_suburb_price_drops has no row for them), s3 has 3.
		// Council B: 2 cuts in all.
		`INSERT INTO suburb_lga VALUES ('s1','A'), ('s2','A'), ('s3','A'), ('s4','B')`,
		`INSERT INTO house_price_regions VALUES ('r1','s1'), ('r2','s2'), ('r3','s3'), ('r4','s4')`,
		`INSERT INTO suburb_demographics VALUES ('s1','One','2000'), ('s2','Two','2001'), ('s3','Three','2002'), ('s4','Four','2003')`,
		// 10 live listings per suburb, ids r*100+n, address = id.
		`INSERT INTO property_listings
			SELECT s * 100 + n, 'r' || s, true, now() - interval '1 day', 'addr-' || (s * 100 + n)
			FROM generate_series(1, 4) s, generate_series(1, 10) n`,
		`INSERT INTO property_price_events VALUES
			(101,'price_drop',now() - interval '2 days',0.05,50000,'rea'),
			(102,'price_drop',now() - interval '2 days',0.03,30000,'rea'),
			(201,'price_drop',now() - interval '2 days',0.10,90000,'rea'),
			(202,'price_drop',now() - interval '2 days',0.02,20000,'rea'),
			(301,'price_drop',now() - interval '2 days',0.04,40000,'rea'),
			(302,'price_drop',now() - interval '2 days',0.06,60000,'rea'),
			(303,'price_drop',now() - interval '2 days',0.08,80000,'rea'),
			(401,'price_drop',now() - interval '2 days',0.05,50000,'rea'),
			(402,'price_drop',now() - interval '2 days',0.05,50000,'rea')`,
		// Excluded, each by one filter: an implausible 50% cut, a cut older
		// than 30 days, a listing not seen for 20 days, and a delisted one.
		`INSERT INTO property_price_events VALUES
			(103,'price_drop',now() - interval '2 days',0.50,500000,'rea'),
			(104,'price_drop',now() - interval '40 days',0.05,50000,'rea'),
			(105,'price_drop',now() - interval '2 days',0.05,50000,'rea'),
			(106,'price_drop',now() - interval '2 days',0.05,50000,'rea')`,
		`UPDATE property_listings SET last_seen_at = now() - interval '20 days' WHERE id = 105`,
		`UPDATE property_listings SET is_active = false WHERE id = 106`,
		// The same address listed on a second portal (a second listing row)
		// with its own cut: still one cut listing.
		`INSERT INTO property_listings VALUES (199, 'r1', true, now() - interval '1 day', 'addr-101')`,
		`INSERT INTO property_price_events VALUES (199,'price_drop',now() - interval '3 days',0.02,20000,'domain')`,
	}
	for _, q := range fixtures {
		if _, err := tx.Exec(ctx, q); err != nil {
			t.Fatalf("fixture %q: %v", q, err)
		}
	}

	rows, err := tx.Query(ctx, councilDropsQuery, "NSW", "", councilDropsMinCount)
	if err != nil {
		t.Fatalf("councilDropsQuery: %v", err)
	}
	got := map[string]map[string][3]any{}
	for rows.Next() {
		var code, sal, name, postcode string
		var dropped, tracked int64
		var median *float64
		var through *time.Time
		var asOf time.Time
		if err := rows.Scan(&code, &sal, &name, &postcode, &dropped, &tracked, &median, &through, &asOf); err != nil {
			t.Fatal(err)
		}
		if got[code] == nil {
			got[code] = map[string][3]any{}
		}
		got[code][sal] = [3]any{dropped, tracked, median}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}

	// Council A's total counts the sub-floor suburbs: 2 + 2 + 3 = 7 cut
	// addresses over 30 live ones (104's listing is live; 105/106 are not).
	// The removed MV-summing version saw only s3's 3 (and, without a
	// per-suburb row, still counted s1 and s2's listings in the denominator).
	total := got["A"][""]
	if total[0] != int64(7) || total[1] != int64(28) {
		t.Fatalf("council A total = %v cuts / %v tracked, want 7 / 28", total[0], total[1])
	}
	if m, _ := total[2].(*float64); m == nil || *m != 0.05 {
		t.Errorf("council A median cut = %v, want 0.05 (median of 7 cuts)", total[2])
	}
	for sal, want := range map[string]int64{"s1": 2, "s2": 2, "s3": 3} {
		if got["A"][sal][0] != want {
			t.Errorf("A/%s dropped = %v, want %d", sal, got["A"][sal][0], want)
		}
	}
	if m, _ := got["A"]["s1"][2].(*float64); m != nil {
		t.Errorf("a median over 2 cuts leaked: %v", *m)
	}
	if m, _ := got["A"]["s3"][2].(*float64); m == nil || *m != 0.06 {
		t.Errorf("A/s3 median = %v, want 0.06", got["A"]["s3"][2])
	}
	if b := got["B"][""]; b[0] != int64(2) {
		t.Errorf("council B total = %v, want 2", b[0])
	}

	agg := aggregateCouncilDrops(&councilDrops{
		Total: CouncilDropSuburbRow{Dropped: int32(total[0].(int64)), Tracked: int32(total[1].(int64))},
		Suburbs: []CouncilDropSuburbRow{
			{SALCode: "s1", Dropped: 2, Tracked: 10}, {SALCode: "s2", Dropped: 2, Tracked: 10}, {SALCode: "s3", Dropped: 3, Tracked: 10},
		},
	})
	if agg == nil || agg.Dropped != 7 || len(agg.Suburbs) != 1 {
		t.Errorf("council A publishes 7 and names only s3: %+v", agg)
	}
}

// TestCouncilHazardRollupNeedsCoverage: the index/choropleth hazard share is
// absent unless covered suburbs hold half the council's member residents, so a
// council with a few mapped suburbs at 0% cannot print "0%" for the whole
// council; a fully covered measured 0 stays a present 0. Temp-table shadowed,
// rolled back.
func TestCouncilHazardRollupNeedsCoverage(t *testing.T) {
	dsn := os.Getenv("SHORTS_TEST_DATABASE_URL")
	if dsn == "" {
		dsn = "postgresql://admin:password@localhost:5438/shorts"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Skipf("database unavailable: %v", err)
	}
	defer pool.Close()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Skipf("database unavailable: %v", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	for _, q := range []string{
		`CREATE TEMP TABLE suburb_lga (sal_code text, lga_code24 text, overlap_lgas jsonb, dominant_share double precision) ON COMMIT DROP`,
		`CREATE TEMP TABLE suburb_demographics (sal_code text, state_code text, population int) ON COMMIT DROP`,
		`CREATE TEMP TABLE suburb_hazard_exposure (sal_code text, flood_planning_share_pct double precision,
			bushfire_prone_share_pct double precision, source_licence text) ON COMMIT DROP`,
		// P: 1 of 4 equal suburbs mapped (at 0%). F: all mapped, all 0%.
		`INSERT INTO suburb_lga VALUES ('p1','P','[]',1), ('p2','P','[]',1), ('p3','P','[]',1), ('p4','P','[]',1),
			('f1','F','[]',1), ('f2','F','[]',1)`,
		`INSERT INTO suburb_demographics SELECT s, 'NSW', 1000 FROM unnest(ARRAY['p1','p2','p3','p4','f1','f2']) s`,
		`INSERT INTO suburb_hazard_exposure VALUES ('p1',0,NULL,'CC-BY-4.0'), ('p2',NULL,NULL,'CC-BY-4.0'),
			('f1',0,10,'CC-BY-4.0'), ('f2',0,NULL,'CC-BY-4.0')`,
	} {
		if _, err := tx.Exec(ctx, q); err != nil {
			t.Fatalf("fixture %q: %v", q, err)
		}
	}
	rows, err := tx.Query(ctx, councilHazardRollupQuery, "NSW", "", councilMemberMinShare, councilHazardMinCoverage)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string][2]*float64{}
	for rows.Next() {
		var code string
		var flood, fire *float64
		if err := rows.Scan(&code, &flood, &fire); err != nil {
			t.Fatal(err)
		}
		got[code] = [2]*float64{flood, fire}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if f := got["P"][0]; f != nil {
		t.Errorf("council P: 1 of 4 suburbs mapped must not print %v%% flood", *f)
	}
	if f := got["F"][0]; f == nil || *f != 0 {
		t.Errorf("council F: fully mapped measured 0 must stay a present 0, got %v", f)
	}
	// F's bushfire: one of two equal suburbs covered = exactly half, publishes.
	if b := got["F"][1]; b == nil || *b != 10 {
		t.Errorf("council F bushfire at 50%% coverage = %v, want 10", b)
	}
}
