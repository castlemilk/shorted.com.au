-- Harden the housing refresh against the same query_canceled starvation that
-- left later shorts MVs stale for 19 days (see 000095). Each view gets an
-- independently guarded concurrent attempt, blocking fallback, and final
-- warning so one failed refresh cannot prevent the remaining views running.

CREATE OR REPLACE FUNCTION refresh_housing_materialized_views()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    BEGIN
        BEGIN
            REFRESH MATERIALIZED VIEW CONCURRENTLY mv_housing_headline;
        EXCEPTION WHEN query_canceled OR OTHERS THEN
            RAISE WARNING 'Failed to refresh mv_housing_headline concurrently: %. Trying non-concurrent...', SQLERRM;
            REFRESH MATERIALIZED VIEW mv_housing_headline;
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
    EXCEPTION WHEN query_canceled OR OTHERS THEN
        RAISE WARNING 'Skipping mv_suburb_crime_latest: %', SQLERRM;
    END;
END;
$$;

-- Belt-and-braces only: callers must disable an already-armed timeout before
-- invoking the function (the collector does so in the same simple-query call).
ALTER FUNCTION refresh_housing_materialized_views() SET statement_timeout TO '0';

COMMENT ON FUNCTION refresh_housing_materialized_views() IS
    'Refreshes every housing MV independently (concurrent, blocking fallback, then warning), explicitly catching query_canceled so one timeout cannot starve later views.';
