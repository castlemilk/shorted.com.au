//go:build integration

package shorts

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// TestSuburbReferenceViews_ProdScaleTiming times the suburb readers on a
// synthetic database the size of prod (2026-10-21: 15,345 SALs, 4,178 suburb
// regions over 3,795 SALs, ~40k house_prices rows), from the live SQL and from
// the 000139 views. It asserts only that both sources agree; the timings are
// logged for the before/after record. Opt-in, it takes a few seconds:
//
//	SUBURB_REFERENCE_BENCH=1 SHORTS_TEST_POSTGRES_URL=... GOWORK=off \
//	  go test -tags integration -run TestSuburbReferenceViews_ProdScaleTiming -v ./shorts/internal/store/shorts/
func TestSuburbReferenceViews_ProdScaleTiming(t *testing.T) {
	if os.Getenv("SUBURB_REFERENCE_BENCH") == "" {
		t.Skip("set SUBURB_REFERENCE_BENCH=1 to time the suburb readers at prod scale")
	}
	pool, cleanup := setupHousingTestDatabase(t)
	defer cleanup()
	setupSuburbExplorerSchema(t, pool)
	ctx := context.Background()

	// Deterministic pseudo-random data: hashtext of the row number.
	_, err := pool.Exec(ctx, `
		TRUNCATE house_prices, house_price_regions, suburb_demographics, suburb_amenities CASCADE;
		INSERT INTO suburb_demographics
			(sal_code, sal_name, state_code, postcode, population, median_age, median_weekly_hhd_income,
			 pct_born_overseas, dwelling_count, pct_rented, pct_owned_outright, pct_owned_mortgage,
			 unemployment_rate, pct_bachelor_or_higher, federal_division, federal_party, federal_party_ab)
		SELECT (10000 + i)::text, 'Suburb ' || i,
		       (ARRAY['NSW','VIC','QLD','SA','WA','TAS','NT','ACT'])[1 + abs(hashtext('s' || i)) % 8],
		       (2000 + i % 7000)::text,
		       abs(hashtext('p' || i)) % 30000,
		       CASE WHEN i % 40 = 0 THEN NULL ELSE 25 + abs(hashtext('a' || i)) % 35 END,
		       800 + abs(hashtext('i' || i)) % 2700,
		       abs(hashtext('b' || i)) % 60,
		       abs(hashtext('d' || i)) % 12000,
		       abs(hashtext('r' || i)) % 70, abs(hashtext('o' || i)) % 50, abs(hashtext('m' || i)) % 50,
		       (abs(hashtext('u' || i)) % 120) / 10.0, abs(hashtext('e' || i)) % 70,
		       'Division ' || (i % 150), 'Party ' || (i % 5), 'P' || (i % 5)
		FROM generate_series(1, 15345) i;
		INSERT INTO suburb_amenities (sal_code, amenity_density_score, dist_to_coast_km)
		SELECT (10000 + i)::text, (abs(hashtext('n' || i)) % 100) / 10.0, abs(hashtext('c' || i)) % 500
		FROM generate_series(1, 15329) i;
		-- 3,795 priced SALs, 383 of them with a second (crawl) region key.
		INSERT INTO house_price_regions (region_code, region_type, region_name, state_code, sal_code)
		SELECT 'SUBURB:' || d.sal_code, 'suburb', d.sal_name, d.state_code, d.sal_code
		FROM suburb_demographics d WHERE d.sal_code::int % 4 = 0 AND d.sal_code::int <= 10000 + 15180;
		INSERT INTO house_price_regions (region_code, region_type, region_name, state_code, sal_code)
		SELECT 'SUBURB:CRAWL-' || d.sal_code, 'suburb', d.sal_name, d.state_code, d.sal_code
		FROM suburb_demographics d WHERE d.sal_code::int % 40 = 0;
		-- ~8 public quarters per VG region, plus a proprietary row per crawl key.
		INSERT INTO house_prices (region_code, measure, dwelling_type, period, period_freq, value, unit, source, source_licence, content_hash)
		SELECT r.region_code, 'median_price', 'house', (date '2024-06-30' - (q * interval '3 months'))::date, 'Q',
		       400000 + abs(hashtext(r.region_code || q)) % 2500000, 'AUD', 'vg', 'CC-BY-4.0', r.region_code || q
		FROM house_price_regions r CROSS JOIN generate_series(0, 9) q
		WHERE r.region_code NOT LIKE 'SUBURB:CRAWL-%' AND abs(hashtext(r.region_code)) % 16 <> 0;
		INSERT INTO house_prices (region_code, measure, dwelling_type, period, period_freq, value, unit, source, source_licence, content_hash)
		SELECT r.region_code, 'median_price', 'house', date '2024-06-30', 'Q', 9999999, 'AUD', 'crawl', 'proprietary-tos-restricted', r.region_code
		FROM house_price_regions r WHERE r.region_code LIKE 'SUBURB:CRAWL-%';
		ANALYZE house_prices; ANALYZE house_price_regions; ANALYZE suburb_demographics; ANALYZE suburb_amenities;`)
	require.NoError(t, err)

	var regions, prices int
	require.NoError(t, pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM house_price_regions), (SELECT count(*) FROM house_prices)`).Scan(&regions, &prices))
	t.Logf("synthetic scale: 15,345 SALs, %d regions, %d house_prices rows", regions, prices)

	buildStart := time.Now()
	applySuburbReferenceViews(t, pool)
	t.Logf("000139 build (three views, indexes, analyze): %v", time.Since(buildStart).Round(time.Millisecond))

	refreshStart := time.Now()
	refreshSuburbReferenceViews(t, pool)
	t.Logf("refresh_suburb_reference_views(): %v", time.Since(refreshStart).Round(time.Millisecond))

	s := &postgresStore{db: pool}
	time3 := func(name string, fn func(src suburbReadSource) error) {
		t.Helper()
		for _, src := range []suburbReadSource{suburbFromLiveSQL, suburbFromViews} {
			require.NoError(t, fn(src)) // warm the cache: the review measured warm-ish calls too
			const n = 20
			start := time.Now()
			for i := 0; i < n; i++ {
				require.NoError(t, fn(src))
			}
			label := "live"
			if src == suburbFromViews {
				label = "views"
			}
			t.Logf("%-22s %-5s %8.2f ms/call", name, label, float64(time.Since(start).Microseconds())/1000/n)
		}
	}
	sals := []string{"10004", "10404", "12004", "15004", "20004"}
	time3("GetSuburbProfile row", func(src suburbReadSource) error {
		for _, sal := range sals[:1] {
			if _, err := s.scanSuburbProfile(ctx, src, sal); err != nil {
				return err
			}
		}
		return nil
	})
	time3("similarSuburbs", func(src suburbReadSource) error {
		_, err := s.querySimilarSuburbs(ctx, src, sals[1], 6)
		return err
	})
	time3("ListStateSuburbs NSW", func(src suburbReadSource) error {
		_, err := s.listStateSuburbs(ctx, src, "NSW", "", 5000)
		return err
	})

	for _, sal := range sals {
		live, err := s.querySimilarSuburbs(ctx, suburbFromLiveSQL, sal, 6)
		require.NoError(t, err)
		views, err := s.querySimilarSuburbs(ctx, suburbFromViews, sal, 6)
		require.NoError(t, err)
		require.Len(t, views, len(live))
		for i := range live {
			require.Equal(t, live[i].SALCode, views[i].SALCode, "similar(%s)[%d]", sal, i)
		}
		lp, err := s.scanSuburbProfile(ctx, suburbFromLiveSQL, sal)
		require.NoError(t, err)
		vp, err := s.scanSuburbProfile(ctx, suburbFromViews, sal)
		require.NoError(t, err)
		require.Equal(t, lp.Summary, vp.Summary, "profile summary %s", sal)
		require.InDelta(t, lp.StateMedianPrice, vp.StateMedianPrice, 1e-6)
		require.InDelta(t, lp.StateCensus.PctRented, vp.StateCensus.PctRented, 1e-9)
	}
}
