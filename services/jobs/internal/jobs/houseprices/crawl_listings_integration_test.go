package houseprices

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// This integration test exercises the REAL pgx SAVEPOINT flow of diffSuburb
// against a live Postgres (the offline suite has no DB). It is the "seeded-DB
// check" the per-row-isolation change needs: it proves that a permanent per-row
// error is isolated (skipped) while the rest of the suburb persists, and — the
// HIGH the adversarial review caught — that a skipped listing is NOT wrongly
// delisted and has its missed_sweeps reset.
//
// Run with a throwaway DB, e.g.:
//
//	docker run -d --name pg -e POSTGRES_PASSWORD=test -e POSTGRES_DB=sptest -p 55438:5432 postgres:16
//	HOUSING_TEST_DB_URL='postgres://postgres:test@localhost:55438/sptest' \
//	  go test ./house-price-collector/ -run TestDiffSuburb_SavepointIsolation_Integration -v
//
// Skips when HOUSING_TEST_DB_URL is unset, so `make test` stays offline.
func TestDiffSuburb_SavepointIsolation_Integration(t *testing.T) {
	dbURL := os.Getenv("HOUSING_TEST_DB_URL")
	if dbURL == "" {
		t.Skip("set HOUSING_TEST_DB_URL to a throwaway Postgres to run the SAVEPOINT integration test")
	}

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer pool.Close()

	// Minimal schema mirroring migration 000076/000078/000079's columns, PLUS an
	// artificial CHECK on display_address length: a listing over it raises SQLSTATE
	// 23514 (check_violation) on upsert — exactly the class of PERMANENT per-row
	// error the SAVEPOINT skip is designed to isolate.
	schema := `
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
  UNIQUE (source, listing_id),
  CONSTRAINT test_addr_len CHECK (display_address IS NULL OR char_length(display_address) <= 200));
CREATE TABLE property_price_events (
  id BIGSERIAL PRIMARY KEY, listing_pk BIGINT NOT NULL REFERENCES property_listings(id) ON DELETE CASCADE,
  source TEXT NOT NULL, listing_id TEXT NOT NULL, region_code TEXT, address_key TEXT, sal_code TEXT,
  observed_at TIMESTAMPTZ NOT NULL, event_type TEXT NOT NULL,
  price DOUBLE PRECISION, price_high DOUBLE PRECISION, price_display TEXT, price_kind TEXT,
  prev_price DOUBLE PRECISION, drop_abs DOUBLE PRECISION, drop_pct DOUBLE PRECISION,
  listing_status TEXT, prev_status TEXT, source_licence TEXT NOT NULL DEFAULT 'proprietary-tos-restricted',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (listing_pk, event_type, observed_at));`
	if _, err := pool.Exec(ctx, schema); err != nil {
		t.Fatalf("create schema: %v", err)
	}

	target := CrawlTarget{Suburb: "testville", Display: "Testville", Postcode: "3000", State: "VIC"}
	region := target.regionCode()
	if _, err := pool.Exec(ctx,
		`INSERT INTO house_price_regions (region_code, region_type, region_name, state_code, postcode)
		 VALUES ($1,'suburb','Testville','VIC','3000')`, region); err != nil {
		t.Fatalf("seed region: %v", err)
	}

	// Seed an EXISTING active listing B with missed_sweeps=1 (one prior absence).
	if _, err := pool.Exec(ctx,
		`INSERT INTO property_listings
		   (source, listing_id, address_key, listing_url, region_code, suburb, state_code, postcode, display_address,
		    price, price_kind, listing_status, is_active, missed_sweeps, content_hash)
		 VALUES ('rea','B','2-old-st-testville-vic-3000','http://x/B',$1,'Testville','VIC','3000','2 Old St',
		         1000000,'fixed','for_sale',true,1,'seed')`, region); err != nil {
		t.Fatalf("seed listing B: %v", err)
	}

	// A complete sweep that saw: A (new, good) + B (present, but its display_address
	// now overflows the CHECK → a permanent 23514 on upsert → must be SKIPPED).
	poison := strings.Repeat("x", 250) // > 200 → CHECK violation
	sweep := suburbSweep{
		status: sweepComplete,
		listings: []RawListing{
			{Source: "rea", ListingID: "A", ListingURL: "http://x/A", Suburb: "Testville", State: "VIC", Postcode: "3000",
				DisplayAddr: "1 Good St", PriceLow: f64p(1_200_000), PriceKind: priceFixed, Status: "for_sale"},
			{Source: "rea", ListingID: "B", ListingURL: "http://x/B", Suburb: "Testville", State: "VIC", Postcode: "3000",
				DisplayAddr: poison, PriceLow: f64p(900_000), PriceKind: priceFixed, Status: "for_sale"},
		},
	}

	lc := testLC()
	runTs := time.Now().UTC()
	events, err := lc.diffSuburb(ctx, pool, target, "rea", sweep, runTs)
	if err != nil {
		t.Fatalf("diffSuburb must NOT fail the suburb on a permanent row error, got: %v", err)
	}

	// The poison row was skipped, the rest of the suburb persisted.
	if lc.stats.skippedRows != 1 {
		t.Errorf("expected skippedRows=1, got %d", lc.stats.skippedRows)
	}
	// A was inserted (a real first_seen event) and is active.
	var aActive bool
	if err := pool.QueryRow(ctx, `SELECT is_active FROM property_listings WHERE source='rea' AND listing_id='A'`).Scan(&aActive); err != nil {
		t.Fatalf("listing A should have persisted despite B failing: %v", err)
	}
	if !aActive {
		t.Error("listing A should be active")
	}
	if events < 1 {
		t.Errorf("expected >=1 event from the good listing A, got %d", events)
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
	var delistedB int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM property_price_events WHERE listing_id='B' AND event_type='delisted'`).Scan(&delistedB); err != nil {
		t.Fatalf("count B delisted: %v", err)
	}
	if delistedB != 0 {
		t.Errorf("skipped listing B must have NO 'delisted' event, got %d", delistedB)
	}
}
