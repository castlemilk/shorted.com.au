DROP INDEX IF EXISTS idx_news_articles_missing_image_covering;
DROP FUNCTION IF EXISTS refresh_stock_price_coverage();
DROP MATERIALIZED VIEW IF EXISTS mv_stock_price_coverage;

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

    RAISE NOTICE 'All materialized views refreshed.';
END;
$$;
