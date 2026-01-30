-- Migration: Fix mv_treemap_data CONCURRENT refresh
-- Created: 2026-01-31
-- Purpose: Add unique index required for CONCURRENT refresh of mv_treemap_data
--
-- ISSUE: The refresh_all_materialized_views() function uses REFRESH MATERIALIZED VIEW
-- CONCURRENTLY for mv_treemap_data, but CONCURRENT refresh requires a UNIQUE index.
-- Without this index, the refresh fails with:
--   ERROR: cannot refresh materialized view "public.mv_treemap_data" concurrently
--   HINT: Create a unique index with no WHERE clause on one or more columns
--
-- The combination of (period_name, product_code) should be unique in the MV.

-- Drop any existing non-unique index on the same columns if needed
-- DROP INDEX IF EXISTS idx_mv_treemap_product;

-- Create unique index for CONCURRENT refresh support
-- This allows REFRESH MATERIALIZED VIEW CONCURRENTLY to work
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_mv_treemap_unique
ON mv_treemap_data (period_name, product_code);

-- Also update the refresh function to handle errors gracefully
-- and log better diagnostics
CREATE OR REPLACE FUNCTION refresh_all_materialized_views()
RETURNS void AS $$
BEGIN
    RAISE NOTICE 'Refreshing mv_treemap_data...';
    BEGIN
        REFRESH MATERIALIZED VIEW CONCURRENTLY mv_treemap_data;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Failed to refresh mv_treemap_data concurrently: %. Trying non-concurrent refresh...', SQLERRM;
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

-- Also refresh the MV now to ensure it has current data
REFRESH MATERIALIZED VIEW mv_treemap_data;

-- Analyze for optimal query performance
ANALYZE mv_treemap_data;

DO $$
BEGIN
    RAISE NOTICE '==============================================';
    RAISE NOTICE 'Migration 011: Fix mv_treemap_data unique index';
    RAISE NOTICE '==============================================';
    RAISE NOTICE 'Added: idx_mv_treemap_unique (period_name, product_code)';
    RAISE NOTICE 'Updated: refresh_all_materialized_views() with error handling';
    RAISE NOTICE 'Refreshed: mv_treemap_data with current data';
    RAISE NOTICE '==============================================';
END $$;
