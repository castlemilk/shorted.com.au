-- Materialize per-symbol stock price coverage. Live pg_stat_statements showed
-- repeated DISTINCT/GROUP BY scans over stock_prices (~3.9M rows, ~2.6-2.8s).
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_stock_price_coverage AS
SELECT
    stock_code,
    MIN(date) AS earliest_date,
    MAX(date) AS latest_date,
    COUNT(*)::integer AS records
FROM stock_prices
WHERE stock_code IS NOT NULL
GROUP BY stock_code;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_stock_price_coverage_stock_code
    ON mv_stock_price_coverage (stock_code);

CREATE INDEX IF NOT EXISTS idx_mv_stock_price_coverage_latest_date
    ON mv_stock_price_coverage (latest_date ASC, stock_code);

CREATE OR REPLACE FUNCTION refresh_stock_price_coverage()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_stock_price_coverage;
END;
$$;

COMMENT ON MATERIALIZED VIEW mv_stock_price_coverage IS
    'Per-stock MIN/MAX/COUNT coverage for stock_prices, used to avoid repeated full-table DISTINCT/GROUP BY scans.';

-- Cover the news image backfill candidate scan:
-- WHERE image_url IS NULL [AND source filters] ORDER BY published_at DESC LIMIT n.
CREATE INDEX IF NOT EXISTS idx_news_articles_missing_image_covering
    ON news_articles (published_at DESC)
    INCLUDE (id, url, source)
    WHERE image_url IS NULL;

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

    RAISE NOTICE 'All materialized views refreshed.';
END;
$$;

ANALYZE mv_stock_price_coverage;
