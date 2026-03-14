-- Add unique index to mv_top_shorts to enable CONCURRENTLY refresh.
-- Without this, REFRESH MATERIALIZED VIEW acquires an exclusive lock that blocks all reads.
-- With CONCURRENTLY, reads can continue during refresh (requires a unique index).

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_top_shorts_product_unique
ON mv_top_shorts (product_code);

-- Update the refresh function to use CONCURRENTLY where possible
CREATE OR REPLACE FUNCTION refresh_all_materialized_views()
RETURNS void AS $$
BEGIN
    RAISE NOTICE 'Refreshing mv_top_shorts (concurrently)...';
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_top_shorts;

    RAISE NOTICE 'Refreshing mv_treemap_data...';
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_treemap_data;

    RAISE NOTICE 'Refreshing mv_watchlist_defaults...';
    REFRESH MATERIALIZED VIEW mv_watchlist_defaults;

    RAISE NOTICE 'Refreshing mv_screener_data (concurrently)...';
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_screener_data;

    RAISE NOTICE 'All materialized views refreshed.';
END;
$$ LANGUAGE plpgsql;
