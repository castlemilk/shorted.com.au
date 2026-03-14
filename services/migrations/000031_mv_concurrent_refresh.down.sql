-- Revert to non-concurrent refresh
DROP INDEX IF EXISTS idx_mv_top_shorts_product_unique;

CREATE OR REPLACE FUNCTION refresh_all_materialized_views()
RETURNS void AS $$
BEGIN
    RAISE NOTICE 'Refreshing mv_top_shorts...';
    REFRESH MATERIALIZED VIEW mv_top_shorts;

    RAISE NOTICE 'Refreshing mv_treemap_data...';
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_treemap_data;

    RAISE NOTICE 'Refreshing mv_watchlist_defaults...';
    REFRESH MATERIALIZED VIEW mv_watchlist_defaults;

    RAISE NOTICE 'Refreshing mv_screener_data (concurrently)...';
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_screener_data;

    RAISE NOTICE 'All materialized views refreshed.';
END;
$$ LANGUAGE plpgsql;
