-- 000049_mv_available_dates
--
-- Materialize SELECT DISTINCT "DATE"::date FROM shorts. That DISTINCT scan over
-- the 2.2M-row shorts table (GetAvailableDates) was ~60% of total DB execution
-- time at ~1.5-2s per call. The set of distinct dates changes only once per day,
-- so a tiny MV (a few thousand date rows) serves it in ~1ms. Refreshed alongside
-- the other MVs after each sync via refresh_all_materialized_views().

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_available_dates AS
SELECT DISTINCT "DATE"::date AS date
FROM shorts;

-- Unique index: enables REFRESH ... CONCURRENTLY and fast ORDER BY date DESC /
-- range scans.
CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_available_dates_date
    ON mv_available_dates (date DESC);

-- Add mv_available_dates to the standard refresh routine. Preserves the four
-- existing MVs from migration 000031.
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

    RAISE NOTICE 'Refreshing mv_available_dates (concurrently)...';
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_available_dates;

    RAISE NOTICE 'All materialized views refreshed.';
END;
$$ LANGUAGE plpgsql;
