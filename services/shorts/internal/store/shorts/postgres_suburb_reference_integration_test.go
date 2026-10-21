//go:build integration

package shorts

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Parity between the suburb readers' two sources: the 000139 views and the
// live SQL they precompute. Both are read from the same seeded database, with
// the real migration file applied, so a view that drifts from the live SQL (a
// licence gate, the region preference, a Census weight, a similarity feature)
// fails here.

const suburbReferenceMigration = "../../../../migrations/000139_suburb_reference_mvs.up.sql"

func applySuburbReferenceViews(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	sql, err := os.ReadFile(suburbReferenceMigration)
	require.NoError(t, err)
	_, err = pool.Exec(context.Background(), string(sql))
	require.NoError(t, err, "apply 000139")
	// An earlier test on a database without the views may have opened the
	// readers' recheck window; these views exist now.
	suburbViewsMissingUntil.Store(0)
}

func refreshSuburbReferenceViews(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `SELECT refresh_suburb_reference_views()`)
	require.NoError(t, err)
}

// seedSuburbReferenceData widens the explorer seed so every branch the views
// precompute is exercised: a YoY pair, a duplicate crawl + Valuer-General SAL,
// a proprietary-only SAL, an unpriced region, amenity and coast features, a
// suburb under the 200-person similarity floor, one with no median age,
// dwelling- and resident-weighted Census shares, and a second priced VIC suburb
// so the state median is a real median. Shares are binary-exact (integers,
// quarters), so the views' GROUP BY and the live LATERAL sum them to the same
// bits whatever order each visits the rows in.
func seedSuburbReferenceData(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	seedDuplicateSuburbRegion(t, pool)
	exec := func(sql string, args ...any) {
		t.Helper()
		_, err := pool.Exec(ctx, sql, args...)
		require.NoError(t, err, sql)
	}
	exec(`
		INSERT INTO house_price_regions (region_code, region_type, region_name, state_code, sal_code) VALUES
			('SUBURB:VIC-FITZROY',  'suburb', 'FITZROY',  'VIC', '20830'),
			('SUBURB:NSW-UNPRICED', 'suburb', 'UNPRICED', 'NSW', '10001'),
			('SUBURB:NSW-BONDI',    'suburb', 'BONDI',    'NSW', '10002')`)
	exec(`
		INSERT INTO house_prices
			(region_code, measure, dwelling_type, period, period_freq, value, unit, source, source_licence, content_hash) VALUES
			('SUBURB:VIC-RICHMOND', 'median_price', 'house', '2023-06-30', 'Q', 1100000, 'AUD', 'vg_vic', 'CC-BY-4.0', 'r0'),
			('SUBURB:VIC-FITZROY',  'median_price', 'house', '2023-06-30', 'A', 1500000, 'AUD', 'vg_vic', 'CC-BY-4.0', 'f1'),
			('SUBURB:VIC-FITZROY',  'median_price', 'house', '2024-06-30', 'A', 1650000, 'AUD', 'vg_vic', 'CC-BY-4.0', 'f2'),
			('SUBURB:NSW-BONDI',    'median_price', 'house', '2024-06-30', 'Q', 3200000, 'AUD', 'vg_nsw', 'CC-BY-4.0', 'b1'),
			('SUBURB:NSW-BONDI',    'median_price', 'house', '2024-06-30', 'Q', 4100000, 'AUD', 'crawl_rea', 'proprietary-tos-restricted', 'b2')`)
	exec(`
		INSERT INTO suburb_demographics
			(sal_code, sal_name, state_code, postcode, population, median_age, median_weekly_hhd_income,
			 pct_born_overseas, dwelling_count, pct_rented, pct_owned_outright, unemployment_rate, pct_bachelor_or_higher) VALUES
			('20830', 'Fitzroy',  'VIC', '3065', 10400, 33, 2300, 28, 5200, 55, 18, 4.25, 61),
			('10001', 'Unpriced', 'NSW', '2999', 150,   51, 1300, 12, 70,   10, 60, 2.0, 15),
			('10002', 'Bondi',    'NSW', '2026', 11500, 34, 2600, 41, 6100, 61, 14, 3.25, 58),
			('10003', 'Noage',    'NSW', '2998', 900,   NULL, 1700, 22, 300, 30, 30, NULL, NULL)`)
	exec(`
		UPDATE suburb_demographics SET pct_born_overseas = 31, dwelling_count = 12000, pct_rented = 45,
		       pct_owned_outright = 22, unemployment_rate = 3.5, pct_bachelor_or_higher = 52
		WHERE sal_code = $1`, salRichmond)
	exec(`
		INSERT INTO suburb_amenities (sal_code, amenity_density_score, dist_to_coast_km) VALUES
			($1, 8.5, 4.2), ('20830', 9.1, 3.9), ('10002', 7.7, 0.2), ($2, 3.1, 140)`, salRichmond, salNorwood)
}

// suburbReferenceSALs is every SAL the seed creates.
var suburbReferenceSALs = []string{
	salRichmond, salNorwood, salCrownland, salAscotVale, "20830", "10001", "10002", "10003",
}

func TestSuburbReferenceViews_MatchTheLiveSQL(t *testing.T) {
	pool, cleanup := setupHousingTestDatabase(t)
	defer cleanup()
	setupSuburbExplorerSchema(t, pool)
	seedSuburbReferenceData(t, pool)
	applySuburbReferenceViews(t, pool)
	s := &postgresStore{db: pool}
	ctx := context.Background()

	for _, state := range []string{"VIC", "SA", "NSW"} {
		live, err := s.listStateSuburbs(ctx, suburbFromLiveSQL, state, "", 5000)
		require.NoError(t, err)
		views, err := s.listStateSuburbs(ctx, suburbFromViews, state, "", 5000)
		require.NoError(t, err)
		require.NotEmpty(t, live, "seed has %s suburbs", state)
		assert.Equal(t, live, views, "ListStateSuburbs(%s): the view must reproduce the live list", state)

		liveCols, liveCodes, err := s.scanSuburbMetricColumns(ctx, suburbFromLiveSQL, state, []string{"price", "population"})
		require.NoError(t, err)
		viewCols, viewCodes, err := s.scanSuburbMetricColumns(ctx, suburbFromViews, state, []string{"price", "population"})
		require.NoError(t, err)
		assert.Equal(t, liveCodes, viewCodes, "metric columns(%s) SAL order", state)
		assert.Equal(t, liveCols, viewCols, "metric columns(%s) values", state)
	}

	for _, sal := range suburbReferenceSALs {
		live, err := s.scanSuburbProfile(ctx, suburbFromLiveSQL, sal)
		require.NoError(t, err, sal)
		views, err := s.scanSuburbProfile(ctx, suburbFromViews, sal)
		require.NoError(t, err, sal)
		assert.Equal(t, live, views, "GetSuburbProfile(%s): the views must reproduce the live row", sal)

		liveSim, err := s.querySimilarSuburbs(ctx, suburbFromLiveSQL, sal, 6)
		require.NoError(t, err, sal)
		viewSim, err := s.querySimilarSuburbs(ctx, suburbFromViews, sal, 6)
		require.NoError(t, err, sal)
		require.Len(t, viewSim, len(liveSim), "similarSuburbs(%s) size", sal)
		for i := range liveSim {
			assert.Equal(t, liveSim[i].SALCode, viewSim[i].SALCode, "similarSuburbs(%s)[%d] order", sal, i)
			assert.Equal(t, liveSim[i].SALName, viewSim[i].SALName)
			assert.Equal(t, liveSim[i].StateCode, viewSim[i].StateCode)
			assert.Equal(t, liveSim[i].RegionCode, viewSim[i].RegionCode)
			assert.Equal(t, liveSim[i].LatestMedianPrice, viewSim[i].LatestMedianPrice)
			// Precomputing x/s instead of (x-t)/s moves the last bits only.
			assert.InDelta(t, liveSim[i].Distance, viewSim[i].Distance, 1e-9, "similarSuburbs(%s)[%d] distance", sal, i)
		}
	}

	// The council suburb table prices its members the same way.
	_, err := pool.Exec(ctx, `
		ALTER TABLE suburb_lga ADD COLUMN IF NOT EXISTS overlap_lgas JSONB NOT NULL DEFAULT '[]'::jsonb;
		ALTER TABLE suburb_lga ADD COLUMN IF NOT EXISTS dominant_share DOUBLE PRECISION;
		CREATE TABLE IF NOT EXISTS suburb_hazard_exposure (
			sal_code TEXT PRIMARY KEY, flood_planning_share_pct DOUBLE PRECISION, bushfire_prone_share_pct DOUBLE PRECISION,
			water_observed_share_pct DOUBLE PRECISION, source_licence TEXT NOT NULL DEFAULT 'CC-BY-4.0');
		INSERT INTO suburb_lga (sal_code, lga_code24, dominant_share) VALUES
			('20604', '24600', 1), ('20075', '24600', 1), ('20830', '24600', 0.9), ('29999', '24600', 1)`)
	require.NoError(t, err)
	liveCouncil, err := s.scanCouncilSuburbs(ctx, suburbFromLiveSQL, "VIC", "24600")
	require.NoError(t, err)
	viewCouncil, err := s.scanCouncilSuburbs(ctx, suburbFromViews, "VIC", "24600")
	require.NoError(t, err)
	require.Len(t, liveCouncil, 4)
	assert.Equal(t, liveCouncil, viewCouncil, "the council suburb table must price members as the live join does")

	// Spot checks, so parity cannot pass by both sides being empty.
	p, err := s.scanSuburbProfile(ctx, suburbFromViews, salRichmond)
	require.NoError(t, err)
	assert.InDelta(t, 1250000.0, p.Summary.LatestMedianPrice, 0.5, "public latest median, never the 9,999,999 crawl value")
	assert.InDelta(t, (1250000.0/1100000.0-1)*100, p.Summary.YoYPct, 1e-9, "YoY against the median 11+ months earlier")
	// VIC public suburb medians: Richmond 1.25M, Ascot Vale 1.3M, Fitzroy 1.65M
	// (Crownland is proprietary-only and excluded).
	assert.InDelta(t, 1300000.0, p.StateMedianPrice, 0.5)
	assert.Greater(t, p.NationalMedianHhdIncome, 0.0)
	assert.Greater(t, p.StateCensus.PctRented, 0.0)
	bondi, err := s.scanSuburbProfile(ctx, suburbFromViews, "10002")
	require.NoError(t, err)
	assert.InDelta(t, 3200000.0, bondi.Summary.LatestMedianPrice, 0.5, "the proprietary 4.1M row never wins")
	unpriced, err := s.scanSuburbProfile(ctx, suburbFromViews, "10001")
	require.NoError(t, err)
	assert.Equal(t, "SUBURB:NSW-UNPRICED", unpriced.Summary.RegionCode, "an unpriced region still identifies the suburb")
	assert.Zero(t, unpriced.Summary.LatestMedianPrice)
	ascot, err := s.scanSuburbProfile(ctx, suburbFromViews, salAscotVale)
	require.NoError(t, err)
	assert.Equal(t, "SUBURB:VIC-ASCOT VALE", ascot.Summary.RegionCode, "the public Valuer-General key wins over the crawl key")
	sim, err := s.querySimilarSuburbs(ctx, suburbFromViews, salRichmond, 6)
	require.NoError(t, err)
	require.NotEmpty(t, sim)
	for _, r := range sim {
		assert.NotEqual(t, "10001", r.SALCode, "a suburb of 200 people or fewer is never a candidate")
		assert.NotEqual(t, "10003", r.SALCode, "a suburb with no median age is never a candidate")
	}
}

// The public readers take the views when they exist: a change to the source
// tables is invisible until the views are refreshed, and visible after.
func TestSuburbReaders_ReadTheViewsUntilRefreshed(t *testing.T) {
	pool, cleanup := setupHousingTestDatabase(t)
	defer cleanup()
	setupSuburbExplorerSchema(t, pool)
	seedSuburbReferenceData(t, pool)
	applySuburbReferenceViews(t, pool)
	s := &postgresStore{db: pool}
	ctx := context.Background()

	_, err := pool.Exec(ctx, `
		INSERT INTO house_prices
			(region_code, measure, dwelling_type, period, period_freq, value, unit, source, source_licence, content_hash)
		VALUES ('SUBURB:SA-NORWOOD', 'median_price', 'house', '2024-09-30', 'Q', 990000, 'AUD', 'vg_sa', 'CC-BY', 'n-new')`)
	require.NoError(t, err)

	norwood := func() float64 {
		rows, err := s.ListStateSuburbs("SA", "", 0)
		require.NoError(t, err)
		for _, r := range rows {
			if r.SALCode == salNorwood {
				return r.LatestMedianPrice
			}
		}
		t.Fatal("Norwood not listed")
		return 0
	}
	assert.InDelta(t, 950000.0, norwood(), 0.5, "the list reads mv_suburb_latest_price, refreshed before the new quarter landed")

	refreshSuburbReferenceViews(t, pool)
	assert.InDelta(t, 990000.0, norwood(), 0.5, "refresh_suburb_reference_views() picks up the new quarter")

	profile, err := s.GetSuburbProfile(salNorwood)
	require.NoError(t, err)
	assert.InDelta(t, 990000.0, profile.Summary.LatestMedianPrice, 0.5)
	assert.InDelta(t, 990000.0, profile.StateMedianPrice, 0.5, "the only priced SA suburb is the SA median")

	// A replay of the migration builds nothing and keeps the refreshed data.
	applySuburbReferenceViews(t, pool)
	assert.InDelta(t, 990000.0, norwood(), 0.5, "a replay must not rebuild or roll back the views")
}

// Without 000139 the public readers fall back to the live SQL (42P01), which
// is how dev, test and prod before the hand-apply keep working.
func TestSuburbReaders_FallBackWithoutTheViews(t *testing.T) {
	pool, cleanup := setupHousingTestDatabase(t)
	defer cleanup()
	setupSuburbExplorerSchema(t, pool)
	seedSuburbReferenceData(t, pool)
	s := &postgresStore{db: pool}

	rows, err := s.ListStateSuburbs("NSW", "Bondi", 0)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	assert.InDelta(t, 3200000.0, rows[0].LatestMedianPrice, 0.5)

	profile, err := s.GetSuburbProfile("10002")
	require.NoError(t, err)
	assert.InDelta(t, 3200000.0, profile.Summary.LatestMedianPrice, 0.5)
	assert.NotEmpty(t, profile.Similar, "similar suburbs come from the live kNN")

	cols, err := s.GetSuburbMetricColumns("NSW", []string{"price"})
	require.NoError(t, err)
	require.Len(t, cols.Columns, 1)
}
