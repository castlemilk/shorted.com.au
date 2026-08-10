//go:build integration

package shorts

import (
	"context"
	"database/sql"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func setupMVCorrectnessTestDatabase(t *testing.T) (*pgxpool.Pool, func()) {
	t.Helper()
	pool, cleanup := setupHousingTestDatabase(t)
	ctx := context.Background()

	const listingSchema = `
		CREATE TABLE property_listings (
			id BIGSERIAL PRIMARY KEY,
			source TEXT NOT NULL,
			listing_id TEXT NOT NULL,
			region_code TEXT,
			state_code TEXT,
			address_key TEXT,
			price DOUBLE PRECISION,
			is_active BOOLEAN NOT NULL DEFAULT true,
			listing_status TEXT NOT NULL DEFAULT 'for_sale',
			last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			agency_id TEXT NOT NULL DEFAULT '',
			agency_name TEXT NOT NULL DEFAULT ''
		);

		CREATE TABLE property_price_events (
			id BIGSERIAL PRIMARY KEY,
			listing_pk BIGINT NOT NULL REFERENCES property_listings(id),
			source TEXT NOT NULL,
			event_type TEXT NOT NULL,
			observed_at TIMESTAMPTZ NOT NULL,
			listing_status TEXT,
			drop_pct DOUBLE PRECISION,
			drop_abs DOUBLE PRECISION
		);

		INSERT INTO property_listings
			(source, listing_id, region_code, state_code, address_key, price,
			 is_active, listing_status, agency_id, agency_name)
		SELECT 'domain', 'big-' || n, 'SUBURB:NSW-BIG', 'NSW', 'big-address-' || n,
		       1000000 + n, true, 'for_sale', 'AG-BIG', 'Big Cuts Realty'
		FROM generate_series(1, 5) AS n;

		INSERT INTO property_listings
			(source, listing_id, region_code, state_code, address_key, price,
			 is_active, listing_status, agency_id, agency_name)
		SELECT 'domain', 'small-' || n, 'SUBURB:NSW-SMALL', 'NSW', 'small-address-' || n,
		       800000 + n, true, 'for_sale', 'AG-SMALL', 'Small Cuts Realty'
		FROM generate_series(1, 5) AS n;

		INSERT INTO property_listings
			(source, listing_id, region_code, state_code, address_key, price,
			 is_active, listing_status, agency_id, agency_name)
		SELECT 'domain', 'quiet-' || n, 'SUBURB:NSW-QUIET', 'NSW', 'quiet-address-' || n,
		       700000 + n, true, 'for_sale', 'AG-QUIET', 'Quiet Realty'
		FROM generate_series(1, 5) AS n;

		INSERT INTO property_price_events
			(listing_pk, source, event_type, observed_at, listing_status, drop_pct, drop_abs)
		SELECT id, source, 'price_drop', now() - interval '1 day', listing_status,
		       CASE listing_id WHEN 'big-1' THEN 0.20 WHEN 'big-2' THEN 0.10 ELSE 0.05 END,
		       CASE listing_id WHEN 'big-1' THEN 200000 WHEN 'big-2' THEN 90000 ELSE 40000 END
		FROM property_listings
		WHERE listing_id IN ('big-1', 'big-2', 'big-3');

		INSERT INTO property_price_events
			(listing_pk, source, event_type, observed_at, listing_status, drop_pct, drop_abs)
		SELECT id, source, 'price_drop', now() - interval '1 day', listing_status, 0.08, 60000
		FROM property_listings
		WHERE listing_id IN ('small-1', 'small-2');

		INSERT INTO property_listings
			(source, listing_id, region_code, state_code, address_key, price,
			 is_active, listing_status)
		VALUES
			('domain', 'sold-1', 'SUBURB:NSW-SOLD', 'NSW', 'sold-address-1', 1400000, false, 'sold'),
			('domain', 'sold-2', 'SUBURB:NSW-SOLD', 'NSW', 'sold-address-2', 1500000, false, 'sold'),
			('domain', 'sold-3', 'SUBURB:NSW-SOLD', 'NSW', 'sold-address-3', 1600000, false, 'sold');

		INSERT INTO property_price_events
			(listing_pk, source, event_type, observed_at, listing_status)
		SELECT id, source, 'relisted', now() - interval '7 days', 'sold'
		FROM property_listings
		WHERE listing_id IN ('sold-1', 'sold-2', 'sold-3');
	`
	_, err := pool.Exec(ctx, listingSchema)
	require.NoError(t, err, "create and seed listing rollup schema")

	migration, err := os.ReadFile("../../../../migrations/000109_fix_listing_rollup_correctness.up.sql")
	require.NoError(t, err, "read migration 000109")
	_, err = pool.Exec(ctx, string(migration))
	require.NoError(t, err, "apply migration 000109")

	return pool, cleanup
}

func TestMVCorrectness_AgencyRankingPrivacyAndDeployedProjection(t *testing.T) {
	pool, cleanup := setupMVCorrectnessTestDatabase(t)
	defer cleanup()
	ctx := context.Background()

	rows, err := pool.Query(ctx, `
		SELECT agency_id, dropped_count, avg_drop_pct, total_drop_value
		FROM mv_agency_stats
		ORDER BY agency_id`)
	require.NoError(t, err)
	defer rows.Close()

	type agencyAggregate struct {
		count int64
		avg   sql.NullFloat64
		value sql.NullFloat64
	}
	got := map[string]agencyAggregate{}
	for rows.Next() {
		var id string
		var aggregate agencyAggregate
		require.NoError(t, rows.Scan(&id, &aggregate.count, &aggregate.avg, &aggregate.value))
		got[id] = aggregate
	}
	require.NoError(t, rows.Err())
	require.Len(t, got, 3)
	assert.Equal(t, int64(3), got["AG-BIG"].count)
	assert.True(t, got["AG-BIG"].avg.Valid)
	assert.True(t, got["AG-BIG"].value.Valid)
	assert.Equal(t, int64(2), got["AG-SMALL"].count, "sub-k counts remain publishable")
	assert.False(t, got["AG-SMALL"].avg.Valid, "sub-k drop depth stays suppressed")
	assert.False(t, got["AG-SMALL"].value.Valid, "sub-k drop value stays suppressed")
	assert.Zero(t, got["AG-QUIET"].count, "agencies without drops retain a non-null zero count")

	store := &postgresStore{db: pool}
	for _, sort := range []string{"drops", "listings", "avg_cut", "value"} {
		stats, listErr := store.ListAgencyPriceStats("", sort, 20)
		require.NoError(t, listErr)
		require.NotEmpty(t, stats)
		assert.Equal(t, "AG-BIG", stats[0].AgencyID, "%s sort must rank the qualifying discounter first", sort)
	}

	// This is the projection used by the binary already deployed when 000109 is
	// hand-applied. The rebuilt MV must keep parsing and scanning until rollout.
	var deployed AgencyPriceStatsRow
	err = pool.QueryRow(ctx, `
		SELECT source, agency_id, agency_name, state_code,
		       active_listings, priced_listings,
		       COALESCE(avg_asking, 0), COALESCE(median_asking, 0),
		       suburbs_covered, dropped_count, COALESCE(avg_drop_pct, 0),
		       COALESCE(total_drop_value, 0), COALESCE(agent_names, '{}')
		FROM mv_agency_stats
		WHERE agency_id = 'AG-QUIET'`).Scan(
		&deployed.Source, &deployed.AgencyID, &deployed.AgencyName, &deployed.StateCode,
		&deployed.ActiveListings, &deployed.PricedListings,
		&deployed.AvgAsking, &deployed.MedianAsking, &deployed.SuburbsCovered,
		&deployed.DroppedCount, &deployed.AvgDropPct, &deployed.TotalDropValue,
		&deployed.AgentNames,
	)
	require.NoError(t, err, "deployed API projection must survive DDL-first rollout")
	assert.Empty(t, deployed.AgentNames)
}

func TestMVCorrectness_SuburbDropExtremaAreSuppressedAtKFloor(t *testing.T) {
	pool, cleanup := setupMVCorrectnessTestDatabase(t)
	defer cleanup()

	var count int64
	var avg, median, maxPct, maxAbs sql.NullFloat64
	err := pool.QueryRow(context.Background(), `
		SELECT dropped_listing_count, avg_drop_pct, median_drop_pct, max_drop_pct, max_drop_abs
		FROM mv_suburb_price_drops
		WHERE region_code = 'SUBURB:NSW-BIG'`).Scan(&count, &avg, &median, &maxPct, &maxAbs)
	require.NoError(t, err)
	assert.Equal(t, int64(3), count)
	assert.True(t, avg.Valid)
	assert.True(t, median.Valid)
	assert.False(t, maxPct.Valid, "per-listing percentage extreme must not be published at k=3")
	assert.False(t, maxAbs.Valid, "per-listing absolute extreme must not be published at k=3")
}

func TestMVCorrectness_RelistedSoldTransitionsAreIncluded(t *testing.T) {
	pool, cleanup := setupMVCorrectnessTestDatabase(t)
	defer cleanup()
	ctx := context.Background()

	var suburbCount int64
	var suburbAverage float64
	err := pool.QueryRow(ctx, `
		SELECT sold_count, avg_sold
		FROM mv_suburb_listing_stats
		WHERE region_code = 'SUBURB:NSW-SOLD'`).Scan(&suburbCount, &suburbAverage)
	require.NoError(t, err)
	assert.Equal(t, int64(3), suburbCount)
	assert.InDelta(t, 1500000, suburbAverage, 0.5)

	var stateCount int64
	var stateAverage float64
	err = pool.QueryRow(ctx, `
		SELECT sold_count, avg_sold
		FROM mv_state_price_drops
		WHERE state_code = 'NSW'`).Scan(&stateCount, &stateAverage)
	require.NoError(t, err)
	assert.Equal(t, int64(3), stateCount)
	assert.InDelta(t, 1500000, stateAverage, 0.5)
}
