package housingcrawl

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/castlemilk/shorted.com.au/services/pkg/testpostgres"
)

// Integration tests for ApplySweep against a live Postgres. The offline suite has
// no database, so these are the proof of the delist and write invariants. Each one
// creates and drops its own tables, so use a throwaway database, e.g.:
//
//	docker run -d --name pg -e POSTGRES_PASSWORD=test -e POSTGRES_DB=sptest -p 55438:5432 postgres:16
//	HOUSING_TEST_DB_URL='postgres://postgres:test@localhost:55438/sptest' \
//	  go test ./pkg/housingcrawl/ -run Integration -v
//
// They skip when HOUSING_TEST_DB_URL is unset, so `make test` stays offline.

// applySchema is a minimal schema mirroring migrations 000076/000078/000079's
// columns, PLUS an artificial CHECK on display_address length: a listing over it
// raises SQLSTATE 23514 (check_violation) on upsert — exactly the class of
// PERMANENT per-row error the SAVEPOINT skip is designed to isolate.
const applySchema = `
DROP TABLE IF EXISTS property_price_events;
DROP TABLE IF EXISTS property_listings;
DROP TABLE IF EXISTS house_price_regions;
CREATE TABLE house_price_regions (
  region_code TEXT PRIMARY KEY, region_type TEXT, region_name TEXT, state_code TEXT, postcode TEXT);
CREATE TABLE property_listings (
  id BIGSERIAL PRIMARY KEY, source TEXT NOT NULL, listing_id TEXT NOT NULL, address_key TEXT,
  listing_url TEXT NOT NULL, region_code TEXT REFERENCES house_price_regions(region_code), sal_code TEXT,
  suburb TEXT, state_code TEXT, postcode TEXT, display_address TEXT,
  latitude DOUBLE PRECISION, longitude DOUBLE PRECISION, property_type TEXT,
  bedrooms SMALLINT, bathrooms SMALLINT, car_spaces SMALLINT, land_size_sqm DOUBLE PRECISION,
  price DOUBLE PRECISION, price_high DOUBLE PRECISION, price_display TEXT,
  price_kind TEXT NOT NULL DEFAULT 'unknown', listing_status TEXT NOT NULL DEFAULT 'for_sale',
  is_active BOOLEAN NOT NULL DEFAULT true, missed_sweeps SMALLINT NOT NULL DEFAULT 0,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_price_change_at TIMESTAMPTZ, source_licence TEXT NOT NULL DEFAULT 'proprietary-tos-restricted',
  content_hash TEXT NOT NULL, agency_id TEXT, agency_name TEXT, agent_names TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ingest_receipt_key TEXT, last_missed_at TIMESTAMPTZ,
  UNIQUE (source, listing_id),
  CONSTRAINT test_addr_len CHECK (display_address IS NULL OR char_length(display_address) <= 200));
CREATE TABLE property_price_events (
  id BIGSERIAL PRIMARY KEY, listing_pk BIGINT NOT NULL REFERENCES property_listings(id) ON DELETE CASCADE,
  source TEXT NOT NULL, listing_id TEXT NOT NULL, region_code TEXT, address_key TEXT, sal_code TEXT,
  observed_at TIMESTAMPTZ NOT NULL, event_type TEXT NOT NULL,
  price DOUBLE PRECISION, price_high DOUBLE PRECISION, price_display TEXT, price_kind TEXT,
  prev_price DOUBLE PRECISION, drop_abs DOUBLE PRECISION, drop_pct DOUBLE PRECISION,
  listing_status TEXT, prev_status TEXT, source_licence TEXT NOT NULL DEFAULT 'proprietary-tos-restricted',
  ingest_receipt_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (listing_pk, event_type, observed_at));`

// applyTarget is the suburb every integration sweep below is made for.
var applyTarget = Target{Suburb: "testville", Display: "Testville", Postcode: "3000", State: "VIC"}

// applyTestDB connects to a throwaway Postgres, recreates the schema, and seeds the
// target's region row. The server is HOUSING_TEST_DB_URL, or a testcontainers
// Postgres with HOUSING_TESTCONTAINERS=1 (see testmain_test.go). It skips when
// neither is set.
func applyTestDB(t *testing.T) (context.Context, *pgxpool.Pool) {
	t.Helper()
	dbURL, err := testpostgres.Admin("HOUSING_TEST_DB_URL", "HOUSING_TESTCONTAINERS")
	if err != nil {
		t.Fatalf("start the test Postgres: %v", err)
	}
	if dbURL == "" {
		t.Skip("set HOUSING_TEST_DB_URL, or HOUSING_TESTCONTAINERS=1 with -tags=testcontainers, to run the ApplySweep integration tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	if _, err := pool.Exec(ctx, applySchema); err != nil {
		t.Fatalf("create schema: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO house_price_regions (region_code, region_type, region_name, state_code, postcode)
		 VALUES ($1,'suburb','Testville','VIC','3000')`, applyTarget.RegionCode()); err != nil {
		t.Fatalf("seed region: %v", err)
	}
	return ctx, pool
}

// seedActive inserts an active, for_sale listing with the given missed_sweeps.
func seedActive(t *testing.T, ctx context.Context, pool *pgxpool.Pool, id string, missed int) {
	t.Helper()
	if _, err := pool.Exec(ctx,
		`INSERT INTO property_listings
		   (source, listing_id, address_key, listing_url, region_code, suburb, state_code, postcode, display_address,
		    price, price_kind, listing_status, is_active, missed_sweeps, content_hash)
		 VALUES ('rea',$1,$2,$3,$4,'Testville','VIC','3000',$5,1000000,'fixed','for_sale',true,$6,'seed')`,
		id, "seed-"+id, "http://x/"+id, applyTarget.RegionCode(), "1 "+id+" St", missed); err != nil {
		t.Fatalf("seed listing %s: %v", id, err)
	}
}

// fixedListing is an on-target, priced listing observed in a sweep.
func fixedListing(id string, price float64) RawListing {
	return RawListing{
		Source: "rea", ListingID: id, ListingURL: "http://x/" + id,
		Suburb: "Testville", State: "VIC", Postcode: "3000",
		DisplayAddr: "1 " + id + " St", PriceLow: new(price), PriceKind: PriceFixed, Status: "for_sale",
	}
}

// countWhere returns the number of rows matching a WHERE clause over the given args.
func countWhere(t *testing.T, ctx context.Context, pool *pgxpool.Pool, query string, args ...any) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(ctx, query, args...).Scan(&n); err != nil {
		t.Fatalf("count %q: %v", query, err)
	}
	return n
}

// listingActive reads is_active and missed_sweeps for one seeded listing.
func listingActive(t *testing.T, ctx context.Context, pool *pgxpool.Pool, id string) (bool, int) {
	t.Helper()
	var active bool
	var missed int
	if err := pool.QueryRow(ctx,
		`SELECT is_active, missed_sweeps FROM property_listings WHERE source='rea' AND listing_id=$1`, id).
		Scan(&active, &missed); err != nil {
		t.Fatalf("load %s: %v", id, err)
	}
	return active, missed
}

// testRules are the thresholds the integration sweeps use: the collector's
// shipped defaults for noise and a two-sweep delist grace.
func testRules() Config {
	return Config{DelistGrace: 2, NoiseAbs: 5000, NoisePct: 0.005}
}

func TestApplySweep_SavepointIsolation_Integration(t *testing.T) {
	ctx, pool := applyTestDB(t)

	// Seed an EXISTING active listing B with missed_sweeps=1 (one prior absence).
	if _, err := pool.Exec(ctx,
		`INSERT INTO property_listings
		   (source, listing_id, address_key, listing_url, region_code, suburb, state_code, postcode, display_address,
		    price, price_kind, listing_status, is_active, missed_sweeps, content_hash)
		 VALUES ('rea','B','2-old-st-testville-vic-3000','http://x/B',$1,'Testville','VIC','3000','2 Old St',
		         1000000,'fixed','for_sale',true,1,'seed')`, applyTarget.RegionCode()); err != nil {
		t.Fatalf("seed listing B: %v", err)
	}

	// A complete sweep that saw: A (new, good) + B (present, but its display_address
	// now overflows the CHECK → a permanent 23514 on upsert → must be SKIPPED).
	poison := strings.Repeat("x", 250) // > 200 → CHECK violation
	b := fixedListing("B", 900_000)
	b.DisplayAddr = poison
	res, err := ApplySweep(ctx, pool, Sweep{
		Target: applyTarget, Source: "rea", Status: Complete, RunTS: time.Now().UTC(), Rules: testRules(),
		Listings: []RawListing{fixedListing("A", 1_200_000), b},
	})
	if err != nil {
		t.Fatalf("ApplySweep must NOT fail the suburb on a permanent row error, got: %v", err)
	}

	// The poison row was skipped, the rest of the suburb persisted.
	if res.SkippedRows != 1 {
		t.Errorf("expected SkippedRows=1, got %d", res.SkippedRows)
	}
	// A was inserted (a real first_seen event) and is active.
	var aActive bool
	if err := pool.QueryRow(ctx, `SELECT is_active FROM property_listings WHERE source='rea' AND listing_id='A'`).Scan(&aActive); err != nil {
		t.Fatalf("listing A should have persisted despite B failing: %v", err)
	}
	if !aActive {
		t.Error("listing A should be active")
	}
	if res.Events < 1 {
		t.Errorf("expected >=1 event from the good listing A, got %d", res.Events)
	}

	// B: the SKIP must NOT touch its snapshot (price unchanged, still for_sale/active)
	// but MUST reset missed_sweeps to 0 (markSeenOnly) so it can't drift to a
	// wrongful delist, and it must NOT have a 'delisted' event.
	var bActive bool
	var bStatus string
	var bMissed int
	var bPrice float64
	if err := pool.QueryRow(ctx,
		`SELECT is_active, listing_status, missed_sweeps, price FROM property_listings WHERE source='rea' AND listing_id='B'`).
		Scan(&bActive, &bStatus, &bMissed, &bPrice); err != nil {
		t.Fatalf("load B: %v", err)
	}
	if !bActive || bStatus != "for_sale" {
		t.Errorf("skipped listing B must remain live, got is_active=%v status=%q (WRONGFUL DELIST)", bActive, bStatus)
	}
	if bMissed != 0 {
		t.Errorf("skipped-but-present B must have missed_sweeps reset to 0 (was 1), got %d — it would drift to a wrongful delist", bMissed)
	}
	if bPrice != 1000000 {
		t.Errorf("skipped B's snapshot must be unchanged (900k rolled back), got price=%v", bPrice)
	}
	if n := countWhere(t, ctx, pool, `SELECT count(*) FROM property_price_events WHERE listing_id='B' AND event_type='delisted'`); n != 0 {
		t.Errorf("skipped listing B must have NO 'delisted' event, got %d", n)
	}
}

// Invariant 1: a BLOCKED sweep writes nothing, even when it carries listings.
func TestApplySweep_BlockedWritesNothing_Integration(t *testing.T) {
	ctx, pool := applyTestDB(t)
	seedActive(t, ctx, pool, "B", 0)

	res, err := ApplySweep(ctx, pool, Sweep{
		Target: applyTarget, Source: "rea", Status: Blocked, RunTS: time.Now().UTC(), Rules: testRules(),
		Listings: []RawListing{fixedListing("A", 1_200_000)},
	})
	if err != nil {
		t.Fatalf("blocked sweep: %v", err)
	}
	if res.Applied != Blocked || res.Events != 0 || res.Upserted != 0 || res.Delisted != 0 {
		t.Errorf("blocked sweep must report nothing applied, got %+v", res)
	}
	if n := countWhere(t, ctx, pool, `SELECT count(*) FROM property_listings WHERE listing_id='A'`); n != 0 {
		t.Errorf("blocked sweep wrote listing A (%d rows)", n)
	}
	if n := countWhere(t, ctx, pool, `SELECT count(*) FROM property_price_events`); n != 0 {
		t.Errorf("blocked sweep wrote %d events", n)
	}
	if active, missed := listingActive(t, ctx, pool, "B"); !active || missed != 0 {
		t.Errorf("blocked sweep touched B: active=%v missed=%d", active, missed)
	}
}

// Invariant 2: a PARTIAL sweep never delists, even when a listing has already
// missed enough sweeps that a COMPLETE sweep would withdraw it.
func TestApplySweep_PartialNeverDelists_Integration(t *testing.T) {
	ctx, pool := applyTestDB(t)
	seedActive(t, ctx, pool, "B", 1) // one more absence would reach DelistGrace=2

	res, err := ApplySweep(ctx, pool, Sweep{
		Target: applyTarget, Source: "rea", Status: Partial, RunTS: time.Now().UTC(), Rules: testRules(),
		Listings: []RawListing{fixedListing("A", 1_200_000)},
	})
	if err != nil {
		t.Fatalf("partial sweep: %v", err)
	}
	if res.Delisted != 0 {
		t.Errorf("partial sweep delisted %d listing(s)", res.Delisted)
	}
	if active, missed := listingActive(t, ctx, pool, "B"); !active || missed != 1 {
		t.Errorf("partial sweep changed absent B: active=%v missed=%d, want active with missed=1", active, missed)
	}
	if n := countWhere(t, ctx, pool, `SELECT count(*) FROM property_price_events WHERE event_type='delisted'`); n != 0 {
		t.Errorf("partial sweep wrote %d delisted event(s)", n)
	}
	// The sweep did run: A was written.
	if n := countWhere(t, ctx, pool, `SELECT count(*) FROM property_listings WHERE listing_id='A'`); n != 1 {
		t.Errorf("partial sweep should still write what it saw, A rows=%d", n)
	}
}

// Invariant 3: a listing is withdrawn only after DelistGrace consecutive COMPLETE
// sweeps in which it was absent — one absent sweep is not enough.
func TestApplySweep_DelistNeedsConsecutiveCompleteSweeps_Integration(t *testing.T) {
	ctx, pool := applyTestDB(t)
	seedActive(t, ctx, pool, "B", 0)
	rules := testRules() // DelistGrace = 2

	complete := func(label string) Result {
		t.Helper()
		res, err := ApplySweep(ctx, pool, Sweep{
			Target: applyTarget, Source: "rea", Status: Complete, RunTS: time.Now().UTC(), Rules: rules,
			Listings: []RawListing{fixedListing("A", 1_200_000)}, // B absent
		})
		if err != nil {
			t.Fatalf("%s: %v", label, err)
		}
		return res
	}

	first := complete("first complete sweep")
	if first.Delisted != 0 {
		t.Fatalf("one absent COMPLETE sweep must not delist (grace=%d), delisted=%d", rules.DelistGrace, first.Delisted)
	}
	if active, missed := listingActive(t, ctx, pool, "B"); !active || missed != 1 {
		t.Fatalf("after one absent sweep want active missed=1, got active=%v missed=%d", active, missed)
	}

	second := complete("second complete sweep")
	if second.Delisted != 1 {
		t.Fatalf("second consecutive absent COMPLETE sweep must delist B, delisted=%d", second.Delisted)
	}
	if active, _ := listingActive(t, ctx, pool, "B"); active {
		t.Error("B should be withdrawn (inactive) after DelistGrace absent COMPLETE sweeps")
	}
	if n := countWhere(t, ctx, pool, `SELECT count(*) FROM property_price_events WHERE listing_id='B' AND event_type='delisted'`); n != 1 {
		t.Errorf("want one delisted event for B, got %d", n)
	}
}

// Invariant 4: a listing that does not belong to the target is never written.
func TestApplySweep_OffTargetNeverWritten_Integration(t *testing.T) {
	ctx, pool := applyTestDB(t)

	wrongPostcode := fixedListing("C", 1_100_000)
	wrongPostcode.Postcode = "3182"
	wrongPostcode.Suburb = "St Kilda"
	nameless := fixedListing("D", 1_300_000)
	nameless.Postcode, nameless.Suburb = "", ""

	res, err := ApplySweep(ctx, pool, Sweep{
		Target: applyTarget, Source: "rea", Status: Complete, RunTS: time.Now().UTC(), Rules: testRules(),
		Listings: []RawListing{fixedListing("A", 1_200_000), wrongPostcode, nameless},
	})
	if err != nil {
		t.Fatalf("ApplySweep: %v", err)
	}
	if res.NewListings != 1 {
		t.Errorf("only the on-target listing is new, got NewListings=%d", res.NewListings)
	}
	for _, id := range []string{"C", "D"} {
		if n := countWhere(t, ctx, pool, `SELECT count(*) FROM property_listings WHERE listing_id=$1`, id); n != 0 {
			t.Errorf("off-target listing %s was written (%d rows)", id, n)
		}
	}
	if n := countWhere(t, ctx, pool, `SELECT count(*) FROM property_listings WHERE listing_id='A'`); n != 1 {
		t.Errorf("on-target listing A rows=%d, want 1", n)
	}
}

// Invariant 5: an out-of-band price is clamped BEFORE events are derived, so it
// can never produce a price move. Without the clamp, $60M against a stored $1.2M
// would read as a price_rise.
func TestApplySweep_ClampBeforeEventDerivation_Integration(t *testing.T) {
	ctx, pool := applyTestDB(t)
	seedActive(t, ctx, pool, "B", 0) // stored at $1,000,000

	poison := fixedListing("B", 60_000_000) // out of the $100k-$50M band
	res, err := ApplySweep(ctx, pool, Sweep{
		Target: applyTarget, Source: "rea", Status: Complete, RunTS: time.Now().UTC(), Rules: testRules(),
		Listings: []RawListing{poison},
	})
	if err != nil {
		t.Fatalf("ApplySweep: %v", err)
	}
	if res.Drops+res.Rises+res.AddressRelistDrops+res.AddressRelistRises != 0 {
		t.Errorf("an out-of-band price must not derive a price move, got drops=%d rises=%d", res.Drops, res.Rises)
	}
	if n := countWhere(t, ctx, pool,
		`SELECT count(*) FROM property_price_events WHERE listing_id='B' AND event_type IN ('price_rise','price_drop')`); n != 0 {
		t.Errorf("clamped listing B wrote %d price move event(s)", n)
	}
}

// A refused sweep writes nothing, not even the listings that were valid. The
// listing from the wrong source sits after a good one, so a partial-write bug
// (validating inside the transaction, or per listing) would leave listing A behind.
func TestApplySweep_SourceMismatchWritesNothing_Integration(t *testing.T) {
	ctx, pool := applyTestDB(t)
	seedActive(t, ctx, pool, "B", 0)

	wrong := fixedListing("C", 1_100_000)
	wrong.Source = "domain"
	_, err := ApplySweep(ctx, pool, Sweep{
		Target: applyTarget, Source: "rea", Status: Complete, RunTS: time.Now().UTC(), Rules: testRules(),
		Listings: []RawListing{fixedListing("A", 1_200_000), wrong},
	})
	if err == nil || !errors.Is(err, ErrInvalidSweep) {
		t.Fatalf("want ErrInvalidSweep for a cross-source listing, got %v", err)
	}
	if n := countWhere(t, ctx, pool, `SELECT count(*) FROM property_listings`); n != 1 {
		t.Errorf("refused sweep wrote rows: property_listings=%d, want only the seeded B", n)
	}
	if n := countWhere(t, ctx, pool, `SELECT count(*) FROM property_price_events`); n != 0 {
		t.Errorf("refused sweep wrote %d event(s)", n)
	}
	if active, missed := listingActive(t, ctx, pool, "B"); !active || missed != 0 {
		t.Errorf("refused sweep touched B: active=%v missed=%d", active, missed)
	}
}
