-- Reverse 000104_add_register_explorer_rollups.

DROP MATERIALIZED VIEW IF EXISTS mv_register_politician_monthly;
DROP MATERIALIZED VIEW IF EXISTS mv_register_politician_rollup;

-- Restore the refresh function as it existed before the explorer rollups.
CREATE OR REPLACE FUNCTION refresh_register_materialized_views()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE NOTICE 'Refreshing mv_register_suburb_property (concurrently)...';
    BEGIN
        BEGIN
            REFRESH MATERIALIZED VIEW CONCURRENTLY mv_register_suburb_property;
        EXCEPTION WHEN query_canceled OR OTHERS THEN
            RAISE WARNING 'Failed to refresh mv_register_suburb_property concurrently: %. Trying non-concurrent...', SQLERRM;
            REFRESH MATERIALIZED VIEW mv_register_suburb_property;
        END;
    EXCEPTION WHEN query_canceled OR OTHERS THEN
        RAISE WARNING 'Skipping mv_register_suburb_property: %', SQLERRM;
    END;

    RAISE NOTICE 'Refreshing mv_register_public_holdings (concurrently)...';
    BEGIN
        BEGIN
            REFRESH MATERIALIZED VIEW CONCURRENTLY mv_register_public_holdings;
        EXCEPTION WHEN query_canceled OR OTHERS THEN
            RAISE WARNING 'Failed to refresh mv_register_public_holdings concurrently: %. Trying non-concurrent...', SQLERRM;
            REFRESH MATERIALIZED VIEW mv_register_public_holdings;
        END;
    EXCEPTION WHEN query_canceled OR OTHERS THEN
        RAISE WARNING 'Skipping mv_register_public_holdings: %', SQLERRM;
    END;
END;
$$;

ALTER FUNCTION refresh_register_materialized_views() SET statement_timeout TO '0';

