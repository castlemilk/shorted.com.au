-- Restore the pre-hardening refresh_all_materialized_views(): the definition as
-- last written by 000083_add_state_exposure.up.sql (the 000073 body plus the
-- mv_company_state_exposure refresh), i.e. unguarded sequential refreshes in the
-- original order, and drop the function-level statement_timeout override.

DROP FUNCTION IF EXISTS refresh_all_materialized_views();

CREATE OR REPLACE FUNCTION refresh_all_materialized_views()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE NOTICE 'Refreshing mv_top_shorts (concurrently)...';
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_top_shorts;

    RAISE NOTICE 'Refreshing mv_treemap_data...';
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_treemap_data;

    RAISE NOTICE 'Refreshing mv_watchlist_defaults...';
    REFRESH MATERIALIZED VIEW mv_watchlist_defaults;

    RAISE NOTICE 'Refreshing mv_screener_data (concurrently)...';
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_screener_data;

    RAISE NOTICE 'Refreshing mv_available_dates (concurrently)...';
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_available_dates;

    RAISE NOTICE 'Refreshing mv_short_campaigns...';
    BEGIN
        REFRESH MATERIALIZED VIEW CONCURRENTLY mv_short_campaigns;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Failed to refresh mv_short_campaigns concurrently: %. Trying non-concurrent...', SQLERRM;
        REFRESH MATERIALIZED VIEW mv_short_campaigns;
    END;

    RAISE NOTICE 'Refreshing mv_stock_price_coverage...';
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_stock_price_coverage;

    RAISE NOTICE 'Refreshing mv_company_state_exposure (concurrently)...';
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_company_state_exposure;

    RAISE NOTICE 'All materialized views refreshed.';
END;
$$;

-- Belt and braces: DROP above already removes the setting, but keep this
-- explicit in case the function was replaced rather than dropped.
ALTER FUNCTION refresh_all_materialized_views() RESET statement_timeout;
