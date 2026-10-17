package main

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Offline shape guard for loadAddressPrior. The two exclusions are what keep a
// cross-portal ask difference and a collapsed multi-unit address from being
// written as price cuts; if either predicate disappears, every drop MV and the
// index silently start counting them again.
func TestAddressPriorSQLExcludesConcurrentPortalAndOtherDwellings(t *testing.T) {
	sql := addressPriorSQL()
	for _, want := range []string{
		"WHERE address_key = $1 AND is_active",
		"AND NOT (source = $2 AND listing_id = $3)",
		"AND NOT (source <> $2 AND last_seen_at >= $5)",
		"AND ($4::smallint IS NULL OR bedrooms IS NULL OR bedrooms = $4::smallint)",
		"ORDER BY last_seen_at DESC, id DESC",
	} {
		if !strings.Contains(sql, want) {
			t.Errorf("addressPriorSQL missing %q:\n%s", want, sql)
		}
	}
	if addressPriorLiveWindow != time.Duration(indexSweepWindowDays)*24*time.Hour {
		t.Errorf("addressPriorLiveWindow = %s, want the %d-day sweep window every listing rollup uses",
			addressPriorLiveWindow, indexSweepWindowDays)
	}
}

// Behaviour against a live Postgres: which earlier advert counts as the prior
// for a brand-new listing at a known address. Uses the same throwaway-DB
// convention as the SAVEPOINT test (it DROPs and recreates its tables):
//
//	HOUSING_TEST_DB_URL='postgres://…/throwaway' go test ./house-price-collector/ -run TestLoadAddressPrior_Integration -v
//
// Skips when HOUSING_TEST_DB_URL is unset, so `make test` stays offline.
func TestLoadAddressPrior_Integration(t *testing.T) {
	dbURL := os.Getenv("HOUSING_TEST_DB_URL")
	if dbURL == "" {
		t.Skip("set HOUSING_TEST_DB_URL to a throwaway Postgres to run the address-prior integration test")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer pool.Close()

	if _, err := pool.Exec(ctx, `
DROP TABLE IF EXISTS property_price_events;
DROP TABLE IF EXISTS property_listings;
CREATE TABLE property_listings (
  id BIGSERIAL PRIMARY KEY, source TEXT NOT NULL, listing_id TEXT NOT NULL,
  address_key TEXT NOT NULL DEFAULT '', bedrooms SMALLINT,
  price DOUBLE PRECISION, price_kind TEXT NOT NULL DEFAULT 'unknown',
  listing_status TEXT NOT NULL DEFAULT 'for_sale', is_active BOOLEAN NOT NULL DEFAULT true,
  missed_sweeps SMALLINT NOT NULL DEFAULT 0, last_seen_at TIMESTAMPTZ NOT NULL,
  UNIQUE (source, listing_id));`); err != nil {
		t.Fatalf("create schema: %v", err)
	}

	runTs := time.Date(2026, 9, 20, 2, 0, 0, 0, time.UTC)
	const addr = "1-centre-road-brighton-vic-3186"
	beds := func(n int16) *int16 { return &n }

	type row struct {
		source, id string
		beds       *int16
		price      float64
		active     bool
		ageDays    int
	}
	seed := func(t *testing.T, rows ...row) {
		t.Helper()
		if _, err := pool.Exec(ctx, `TRUNCATE property_listings`); err != nil {
			t.Fatalf("truncate: %v", err)
		}
		for _, r := range rows {
			if _, err := pool.Exec(ctx, `
				INSERT INTO property_listings (source, listing_id, address_key, bedrooms, price, price_kind, is_active, last_seen_at)
				VALUES ($1,$2,$3,$4,$5,'fixed',$6,$7)`,
				r.source, r.id, addr, r.beds, r.price, r.active,
				runTs.Add(-time.Duration(r.ageDays)*24*time.Hour)); err != nil {
				t.Fatalf("seed %s/%s: %v", r.source, r.id, err)
			}
		}
	}
	prior := func(t *testing.T, source, id string, b *int16) *storedListing {
		t.Helper()
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatalf("begin: %v", err)
		}
		defer func() { _ = tx.Rollback(ctx) }()
		p, err := loadAddressPrior(ctx, tx, addr, id, source, b, runTs)
		if err != nil {
			t.Fatalf("loadAddressPrior: %v", err)
		}
		return p
	}

	t.Run("the other portal's concurrent advert is not a prior", func(t *testing.T) {
		seed(t, row{"rea", "R1", beds(3), 1_200_000, true, 2})
		if p := prior(t, "domain", "D1", beds(3)); p != nil {
			t.Fatalf("a REA listing seen 2 days ago is live alongside the new Domain one, got prior %s", p.ListingID)
		}
	})

	t.Run("an other-portal advert gone quiet past the live window is a relist prior", func(t *testing.T) {
		seed(t, row{"rea", "R1", beds(3), 1_200_000, true, 20})
		p := prior(t, "domain", "D1", beds(3))
		if p == nil || p.ListingID != "R1" {
			t.Fatalf("want R1 (last seen 20 days ago) as the prior, got %+v", p)
		}
	})

	t.Run("a same-portal earlier advert is a prior however recent", func(t *testing.T) {
		seed(t, row{"rea", "R1", beds(3), 1_200_000, true, 1})
		p := prior(t, "rea", "R2", beds(3))
		if p == nil || p.ListingID != "R1" {
			t.Fatalf("a new REA id at the address must compare against the earlier REA advert, got %+v", p)
		}
	})

	t.Run("the concurrent advert is skipped in favour of an eligible older one", func(t *testing.T) {
		seed(t,
			row{"rea", "R1", beds(3), 1_150_000, true, 1},
			row{"domain", "D0", beds(3), 1_300_000, true, 18},
		)
		p := prior(t, "domain", "D1", beds(3))
		if p == nil || p.ListingID != "D0" {
			t.Fatalf("want the earlier Domain advert D0, not the concurrent REA one, got %+v", p)
		}
	})

	t.Run("a different bedroom count is a different dwelling", func(t *testing.T) {
		seed(t, row{"rea", "R1", beds(2), 700_000, true, 1})
		if p := prior(t, "rea", "R2", beds(4)); p != nil {
			t.Fatalf("a 2-bed prior must not price a 4-bed listing, got %s", p.ListingID)
		}
	})

	t.Run("an unknown bedroom count on either side does not block", func(t *testing.T) {
		seed(t, row{"rea", "R1", nil, 1_200_000, true, 1})
		if p := prior(t, "rea", "R2", beds(3)); p == nil {
			t.Fatal("prior with unknown bedrooms must still match")
		}
		seed(t, row{"rea", "R1", beds(3), 1_200_000, true, 1})
		if p := prior(t, "rea", "R2", nil); p == nil {
			t.Fatal("new listing with unknown bedrooms must still match")
		}
	})

	t.Run("an inactive advert is never a prior", func(t *testing.T) {
		seed(t, row{"rea", "R1", beds(3), 1_200_000, false, 20})
		if p := prior(t, "domain", "D1", beds(3)); p != nil {
			t.Fatalf("inactive prior must be ignored, got %s", p.ListingID)
		}
	})
}
