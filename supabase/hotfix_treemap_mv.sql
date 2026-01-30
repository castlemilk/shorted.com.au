-- HOTFIX: Fix mv_treemap_data materialized view
-- Run this in production Supabase SQL editor to fix the 500 errors
--
-- Issue: The refresh function uses CONCURRENT refresh but there's no UNIQUE index

-- Step 1: Check if mv_treemap_data exists and its current state
SELECT
    schemaname,
    matviewname,
    hasindexes,
    ispopulated
FROM pg_matviews
WHERE matviewname = 'mv_treemap_data';

-- Step 2: Check existing indexes on the MV
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'mv_treemap_data';

-- Step 3: Check row count and sample data
SELECT COUNT(*) as row_count FROM mv_treemap_data;
SELECT * FROM mv_treemap_data LIMIT 5;

-- Step 4: Add unique index (required for CONCURRENT refresh)
-- Run this ONLY if the unique index doesn't exist
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_mv_treemap_unique
ON mv_treemap_data (period_name, product_code);

-- Step 5: Refresh the materialized view with current data
-- This should now work with CONCURRENTLY since we have a unique index
REFRESH MATERIALIZED VIEW CONCURRENTLY mv_treemap_data;

-- Step 6: Verify data after refresh
SELECT
    period_name,
    COUNT(*) as stock_count,
    MAX(last_refreshed) as last_refresh
FROM mv_treemap_data
GROUP BY period_name
ORDER BY period_name;

-- Step 7: Update the refresh function with error handling
CREATE OR REPLACE FUNCTION refresh_all_materialized_views()
RETURNS void AS $$
BEGIN
    RAISE NOTICE 'Refreshing mv_treemap_data...';
    BEGIN
        REFRESH MATERIALIZED VIEW CONCURRENTLY mv_treemap_data;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'CONCURRENT refresh failed: %. Using non-concurrent refresh...', SQLERRM;
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
