-- Reverse 000127: restore 000124's refresh function (without the council
-- block) BEFORE dropping the view, so no refresh ever names a missing view,
-- then drop the view, its bookkeeping row and the data_through index. The
-- council store falls back to its live query when the view is absent.

BEGIN;

SET LOCAL statement_timeout = 0;

-- Refresh function, verbatim from 000124.
CREATE OR REPLACE FUNCTION refresh_housing_materialized_views()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    v_crawl_through timestamptz;
BEGIN
    -- Read before any refresh, so data_through can only understate what the
    -- crawl-derived views contain, never overstate it.
    BEGIN
        SELECT GREATEST((SELECT max(observed_at) FROM property_price_events),
                        (SELECT max(last_seen_at) FROM property_listings))
          INTO v_crawl_through;
    EXCEPTION WHEN query_canceled OR OTHERS THEN
        RAISE WARNING 'Could not read the crawl horizon for housing_mv_refresh: %', SQLERRM;
        v_crawl_through := NULL;
    END;

    BEGIN
        BEGIN
            REFRESH MATERIALIZED VIEW CONCURRENTLY mv_housing_headline;
        EXCEPTION WHEN query_canceled OR OTHERS THEN
            RAISE WARNING 'Failed to refresh mv_housing_headline concurrently: %. Trying non-concurrent...', SQLERRM;
            REFRESH MATERIALIZED VIEW mv_housing_headline;
        END;
        BEGIN
            INSERT INTO housing_mv_refresh (mv_name, refreshed_at, data_through)
            VALUES ('mv_housing_headline', now(), NULL)
            ON CONFLICT (mv_name) DO UPDATE
                SET refreshed_at = EXCLUDED.refreshed_at, data_through = EXCLUDED.data_through;
        EXCEPTION WHEN query_canceled OR OTHERS THEN
            RAISE WARNING 'Refreshed mv_housing_headline but could not record it: %', SQLERRM;
        END;
    EXCEPTION WHEN query_canceled OR OTHERS THEN
        RAISE WARNING 'Skipping mv_housing_headline: %', SQLERRM;
    END;

    BEGIN
        BEGIN
            REFRESH MATERIALIZED VIEW CONCURRENTLY mv_suburb_price_drops;
        EXCEPTION WHEN query_canceled OR OTHERS THEN
            RAISE WARNING 'Failed to refresh mv_suburb_price_drops concurrently: %. Trying non-concurrent...', SQLERRM;
            REFRESH MATERIALIZED VIEW mv_suburb_price_drops;
        END;
        BEGIN
            INSERT INTO housing_mv_refresh (mv_name, refreshed_at, data_through)
            VALUES ('mv_suburb_price_drops', now(), v_crawl_through)
            ON CONFLICT (mv_name) DO UPDATE
                SET refreshed_at = EXCLUDED.refreshed_at, data_through = EXCLUDED.data_through;
        EXCEPTION WHEN query_canceled OR OTHERS THEN
            RAISE WARNING 'Refreshed mv_suburb_price_drops but could not record it: %', SQLERRM;
        END;
    EXCEPTION WHEN query_canceled OR OTHERS THEN
        RAISE WARNING 'Skipping mv_suburb_price_drops: %', SQLERRM;
    END;

    BEGIN
        BEGIN
            REFRESH MATERIALIZED VIEW CONCURRENTLY mv_suburb_listing_stats;
        EXCEPTION WHEN query_canceled OR OTHERS THEN
            RAISE WARNING 'Failed to refresh mv_suburb_listing_stats concurrently: %. Trying non-concurrent...', SQLERRM;
            REFRESH MATERIALIZED VIEW mv_suburb_listing_stats;
        END;
        BEGIN
            INSERT INTO housing_mv_refresh (mv_name, refreshed_at, data_through)
            VALUES ('mv_suburb_listing_stats', now(), v_crawl_through)
            ON CONFLICT (mv_name) DO UPDATE
                SET refreshed_at = EXCLUDED.refreshed_at, data_through = EXCLUDED.data_through;
        EXCEPTION WHEN query_canceled OR OTHERS THEN
            RAISE WARNING 'Refreshed mv_suburb_listing_stats but could not record it: %', SQLERRM;
        END;
    EXCEPTION WHEN query_canceled OR OTHERS THEN
        RAISE WARNING 'Skipping mv_suburb_listing_stats: %', SQLERRM;
    END;

    BEGIN
        BEGIN
            REFRESH MATERIALIZED VIEW CONCURRENTLY mv_state_price_drops;
        EXCEPTION WHEN query_canceled OR OTHERS THEN
            RAISE WARNING 'Failed to refresh mv_state_price_drops concurrently: %. Trying non-concurrent...', SQLERRM;
            REFRESH MATERIALIZED VIEW mv_state_price_drops;
        END;
        BEGIN
            INSERT INTO housing_mv_refresh (mv_name, refreshed_at, data_through)
            VALUES ('mv_state_price_drops', now(), v_crawl_through)
            ON CONFLICT (mv_name) DO UPDATE
                SET refreshed_at = EXCLUDED.refreshed_at, data_through = EXCLUDED.data_through;
        EXCEPTION WHEN query_canceled OR OTHERS THEN
            RAISE WARNING 'Refreshed mv_state_price_drops but could not record it: %', SQLERRM;
        END;
    EXCEPTION WHEN query_canceled OR OTHERS THEN
        RAISE WARNING 'Skipping mv_state_price_drops: %', SQLERRM;
    END;

    BEGIN
        BEGIN
            REFRESH MATERIALIZED VIEW CONCURRENTLY mv_agency_stats;
        EXCEPTION WHEN query_canceled OR OTHERS THEN
            RAISE WARNING 'Failed to refresh mv_agency_stats concurrently: %. Trying non-concurrent...', SQLERRM;
            REFRESH MATERIALIZED VIEW mv_agency_stats;
        END;
        BEGIN
            INSERT INTO housing_mv_refresh (mv_name, refreshed_at, data_through)
            VALUES ('mv_agency_stats', now(), v_crawl_through)
            ON CONFLICT (mv_name) DO UPDATE
                SET refreshed_at = EXCLUDED.refreshed_at, data_through = EXCLUDED.data_through;
        EXCEPTION WHEN query_canceled OR OTHERS THEN
            RAISE WARNING 'Refreshed mv_agency_stats but could not record it: %', SQLERRM;
        END;
    EXCEPTION WHEN query_canceled OR OTHERS THEN
        RAISE WARNING 'Skipping mv_agency_stats: %', SQLERRM;
    END;

    BEGIN
        BEGIN
            REFRESH MATERIALIZED VIEW CONCURRENTLY mv_suburb_crime_latest;
        EXCEPTION WHEN query_canceled OR OTHERS THEN
            RAISE WARNING 'Failed to refresh mv_suburb_crime_latest concurrently: %. Trying non-concurrent...', SQLERRM;
            REFRESH MATERIALIZED VIEW mv_suburb_crime_latest;
        END;
        BEGIN
            INSERT INTO housing_mv_refresh (mv_name, refreshed_at, data_through)
            VALUES ('mv_suburb_crime_latest', now(), NULL)
            ON CONFLICT (mv_name) DO UPDATE
                SET refreshed_at = EXCLUDED.refreshed_at, data_through = EXCLUDED.data_through;
        EXCEPTION WHEN query_canceled OR OTHERS THEN
            RAISE WARNING 'Refreshed mv_suburb_crime_latest but could not record it: %', SQLERRM;
        END;
    EXCEPTION WHEN query_canceled OR OTHERS THEN
        RAISE WARNING 'Skipping mv_suburb_crime_latest: %', SQLERRM;
    END;
END;
$$;

ALTER FUNCTION refresh_housing_materialized_views() SET statement_timeout TO '0';

COMMENT ON FUNCTION refresh_housing_materialized_views() IS
    'Refreshes every housing MV independently (concurrent, blocking fallback, then warning), explicitly catching query_canceled so one timeout cannot starve later views, and records each successful refresh in housing_mv_refresh.';

DROP MATERIALIZED VIEW IF EXISTS mv_council_price_drops;

DELETE FROM housing_mv_refresh WHERE mv_name = 'mv_council_price_drops';

DROP INDEX IF EXISTS idx_lga_series_public_latest;

COMMIT;
