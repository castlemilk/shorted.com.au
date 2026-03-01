-- Rollback screener materialized view

DROP INDEX IF EXISTS idx_mv_screener_data_industry;
DROP INDEX IF EXISTS idx_mv_screener_data_market_cap;
DROP INDEX IF EXISTS idx_mv_screener_data_short_pct;
DROP INDEX IF EXISTS idx_mv_screener_data_stock_code;
DROP MATERIALIZED VIEW IF EXISTS mv_screener_data CASCADE;

-- Restore refresh function without screener MV
CREATE OR REPLACE FUNCTION refresh_all_materialized_views()
RETURNS void AS $$
BEGIN
    RAISE NOTICE 'Refreshing mv_treemap_data...';
    BEGIN
        REFRESH MATERIALIZED VIEW CONCURRENTLY mv_treemap_data;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Failed to refresh mv_treemap_data concurrently: %. Trying non-concurrent...', SQLERRM;
        REFRESH MATERIALIZED VIEW mv_treemap_data;
    END;

    RAISE NOTICE 'Refreshing mv_top_shorts...';
    REFRESH MATERIALIZED VIEW mv_top_shorts;

    RAISE NOTICE 'Refreshing mv_watchlist_defaults...';
    REFRESH MATERIALIZED VIEW mv_watchlist_defaults;

    RAISE NOTICE 'All materialized views refreshed successfully';
END;
$$ LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp;
