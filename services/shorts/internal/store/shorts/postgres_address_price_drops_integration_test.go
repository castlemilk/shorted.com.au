//go:build integration

package shorts

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestListAddressPriceDrops_BoardDoesNotDependOnSweepOrder runs the real board
// query against the cases that decide which advert an address is judged on.
//
// The regression: the board picked ONE "current" advert per address — the one
// the crawl saw last — and the chain rule then kept the other portal's events
// off it. A real REA cut vanished whenever the Domain advert of the same home
// was swept later, and came back after the next REA sweep (79 addresses on
// prod, 2026-09-24), while mv_suburb_price_drops kept counting them.
func TestListAddressPriceDrops_BoardDoesNotDependOnSweepOrder(t *testing.T) {
	pool, cleanup := setupHousingTestDatabase(t)
	defer cleanup()
	ctx := context.Background()

	const schema = `
		CREATE TABLE property_listings (
			id              BIGSERIAL PRIMARY KEY,
			source          TEXT NOT NULL,
			listing_id      TEXT NOT NULL,
			listing_url     TEXT NOT NULL,
			address_key     TEXT,
			suburb          TEXT,
			state_code      TEXT,
			postcode        TEXT,
			display_address TEXT,
			property_type   TEXT,
			bedrooms        SMALLINT,
			bathrooms       SMALLINT,
			price           DOUBLE PRECISION,
			price_kind      TEXT NOT NULL DEFAULT 'unknown',
			is_active       BOOLEAN NOT NULL DEFAULT true,
			first_seen_at   TIMESTAMPTZ NOT NULL,
			last_seen_at    TIMESTAMPTZ NOT NULL,
			agency_name     TEXT NOT NULL DEFAULT '',
			agent_names     TEXT[] NOT NULL DEFAULT '{}',
			UNIQUE (source, listing_id)
		);
		CREATE TABLE property_price_events (
			id          BIGSERIAL PRIMARY KEY,
			listing_pk  BIGINT NOT NULL REFERENCES property_listings(id),
			address_key TEXT,
			observed_at TIMESTAMPTZ NOT NULL,
			event_type  TEXT NOT NULL,
			price       DOUBLE PRECISION,
			price_kind  TEXT,
			prev_price  DOUBLE PRECISION,
			drop_pct    DOUBLE PRECISION
		);`
	_, err := pool.Exec(ctx, schema)
	require.NoError(t, err)

	// listing inserts one advert; days are offsets from now().
	listing := func(source, id, addr string, beds int, price float64, firstDaysAgo, lastDaysAgo float64) int64 {
		t.Helper()
		var pk int64
		err := pool.QueryRow(ctx, `
			INSERT INTO property_listings
				(source, listing_id, listing_url, address_key, suburb, state_code, postcode,
				 display_address, property_type, bedrooms, bathrooms, price, price_kind,
				 first_seen_at, last_seen_at)
			VALUES ($1, $2, 'https://example.test/' || $2, $3, 'Richmond', 'VIC', '3121',
			        $3, 'house', $4, 2, $5, 'fixed',
			        now() - make_interval(secs => $6 * 86400),
			        now() - make_interval(secs => $7 * 86400))
			RETURNING id`,
			source, id, addr, beds, price, firstDaysAgo, lastDaysAgo).Scan(&pk)
		require.NoError(t, err)
		return pk
	}
	// event inserts one price event on pk at daysAgo.
	event := func(pk int64, addr, kind string, daysAgo float64, price, prev float64) {
		t.Helper()
		var dropPct any
		if kind == "price_drop" {
			dropPct = (prev - price) / prev
		}
		var prevPrice any
		if prev > 0 {
			prevPrice = prev
		}
		_, err := pool.Exec(ctx, `
			INSERT INTO property_price_events
				(listing_pk, address_key, observed_at, event_type, price, price_kind, prev_price, drop_pct)
			VALUES ($1, $2, now() - make_interval(secs => $3 * 86400), $4, $5, 'fixed', $6, $7)`,
			pk, addr, daysAgo, kind, price, prevPrice, dropPct)
		require.NoError(t, err)
	}

	// Two identical homes, each live on both portals at once: REA cut
	// $1.0M -> $950k (a detected drop), Domain showing $980k throughout. The
	// only difference is which portal the crawl swept last.
	for _, c := range []struct {
		addr             string
		reaLast, domLast float64
	}{
		{addr: "1-rea-swept-last", reaLast: 1, domLast: 2},
		{addr: "2-domain-swept-last", reaLast: 2, domLast: 1},
	} {
		rea := listing("rea", c.addr+"-rea", c.addr, 3, 950_000, 20, c.reaLast)
		event(rea, c.addr, "first_seen", 20, 1_000_000, 0)
		event(rea, c.addr, "price_drop", 5, 950_000, 1_000_000)
		dom := listing("domain", c.addr+"-dom", c.addr, 3, 980_000, 19, c.domLast)
		event(dom, c.addr, "first_seen", 19, 980_000, 0)
	}

	// Two units under one collapsed address_key, live on the SAME portal at
	// once. The collector's relist path recorded the second one's first
	// sighting as a "drop" from the first unit's ask — not a cut.
	unitA := listing("rea", "3-units-a", "3-concurrent-units", 2, 1_000_000, 10, 1)
	event(unitA, "3-concurrent-units", "first_seen", 10, 1_000_000, 0)
	unitB := listing("rea", "3-units-b", "3-concurrent-units", 2, 900_000, 10, 1)
	event(unitB, "3-concurrent-units", "first_seen", 10, 900_000, 0)
	event(unitB, "3-concurrent-units", "price_drop", 10, 900_000, 1_000_000)

	// A relist: the old REA advert was cut $1.0M -> $900k, then withdrawn and
	// relisted at $950k. The old advert is still inside the 14-day liveness
	// window, but its $900k is not the current ask — the relist's $950k is.
	old := listing("rea", "4-old", "4-relisted", 3, 900_000, 12, 6)
	event(old, "4-relisted", "first_seen", 12, 1_000_000, 0)
	event(old, "4-relisted", "price_drop", 8, 900_000, 1_000_000)
	relist := listing("rea", "4-new", "4-relisted", 3, 950_000, 3, 1)
	event(relist, "4-relisted", "first_seen", 3, 950_000, 0)

	store := &postgresStore{db: pool}
	rows, err := store.ListAddressPriceDrops("", "pct", 90, 50)
	require.NoError(t, err)

	got := map[string]*AddressPriceDropRow{}
	for _, r := range rows {
		got[r.AddressKey] = r
	}

	for _, addr := range []string{"1-rea-swept-last", "2-domain-swept-last"} {
		r := got[addr]
		if assert.NotNil(t, r, "%s: a detected REA cut must be listed whichever portal was swept last", addr) {
			assert.Equal(t, "rea", r.LatestSource, addr)
			assert.InDelta(t, 1_000_000, r.FirstPrice, 0.01, addr)
			assert.InDelta(t, 950_000, r.CurrentPrice, 0.01, addr)
			assert.InDelta(t, 0.05, r.DropPct, 1e-9, addr)
			assert.Equal(t, int32(2), r.NumListings, addr)
		}
	}

	assert.NotContains(t, got, "3-concurrent-units",
		"two concurrent adverts on one portal showing different asks is not a cut")

	if r := got["4-relisted"]; assert.NotNil(t, r, "the relist inherits the old advert's cut") {
		assert.Equal(t, "https://example.test/4-new", r.LatestListingURL,
			"a superseded advert must not present its old ask as current")
		assert.InDelta(t, 950_000, r.CurrentPrice, 0.01)
		assert.InDelta(t, 0.05, r.DropPct, 1e-9)
	}

	assert.Len(t, rows, 3)
}
