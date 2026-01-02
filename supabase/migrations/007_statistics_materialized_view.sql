-- Migration: Statistics Materialized View
-- Created: 2025-12-23
-- Purpose: Pre-calculate about page statistics for fast SSR responses
-- 
-- This materialized view provides instant access to:
-- - Total count of unique companies with short positions
-- - Count of unique industries
-- - Latest data update date
-- 
-- Performance: Eliminates expensive COUNT DISTINCT queries on every page load

-- Drop existing view if upgrading
DROP MATERIALIZED VIEW IF EXISTS mv_about_statistics CASCADE;

-- Create materialized view for about page statistics
CREATE MATERIALIZED VIEW mv_about_statistics AS
WITH latest_data AS (
    -- Get the most recent date in the shorts table
    SELECT MAX("DATE") as latest_date FROM shorts
),
active_stocks AS (
    -- Count stocks that have recent data (within 1 month of latest)
    -- This excludes delisted or inactive stocks
    SELECT DISTINCT s."PRODUCT_CODE"
    FROM shorts s
    CROSS JOIN latest_data ld
    WHERE s."DATE" > ld.latest_date - INTERVAL '1 month'
      AND s."PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" > 0
),
industry_stats AS (
    -- Count unique industries from company metadata for active stocks
    SELECT COUNT(DISTINCT cm.industry) as industry_count
    FROM "company-metadata" cm
    INNER JOIN active_stocks a ON cm.stock_code = a."PRODUCT_CODE"
    WHERE cm.industry IS NOT NULL AND cm.industry != ''
)
SELECT 
    (SELECT COUNT(*) FROM active_stocks) as company_count,
    COALESCE((SELECT industry_count FROM industry_stats), 0) as industry_count,
    (SELECT latest_date FROM latest_data) as latest_update_date,
    NOW() as last_refreshed;

-- Create index for optimal query performance (single row table, but good practice)
CREATE UNIQUE INDEX idx_mv_about_statistics_singleton 
ON mv_about_statistics (last_refreshed);

-- Add comments for documentation
COMMENT ON MATERIALIZED VIEW mv_about_statistics IS 
'Pre-calculated statistics for the about page. Refresh after shorts data sync. Single row with aggregate counts.';

COMMENT ON COLUMN mv_about_statistics.company_count IS 
'Count of unique companies with active short positions (reported within last month)';

COMMENT ON COLUMN mv_about_statistics.industry_count IS 
'Count of unique industries represented by shorted companies';

COMMENT ON COLUMN mv_about_statistics.latest_update_date IS 
'Most recent date when short position data was reported';

COMMENT ON COLUMN mv_about_statistics.last_refreshed IS 
'Timestamp when the materialized view was last refreshed';

-- Create function to refresh the statistics materialized view
CREATE OR REPLACE FUNCTION refresh_about_statistics()
RETURNS void AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_about_statistics;
    RAISE NOTICE 'Materialized view mv_about_statistics refreshed successfully';
END;
$$ LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp;

COMMENT ON FUNCTION refresh_about_statistics() IS 
'Refresh the about statistics materialized view. Call this after loading new shorts data.';

-- Create a helper function to get statistics as JSON (useful for API calls)
CREATE OR REPLACE FUNCTION get_about_statistics()
RETURNS JSON AS $$
DECLARE
    result JSON;
BEGIN
    SELECT json_build_object(
        'company_count', company_count,
        'industry_count', industry_count,
        'latest_update_date', latest_update_date,
        'last_refreshed', last_refreshed
    )
    INTO result
    FROM mv_about_statistics
    LIMIT 1;
    
    -- If no data exists, return defaults
    IF result IS NULL THEN
        result := json_build_object(
            'company_count', 0,
            'industry_count', 0,
            'latest_update_date', NULL,
            'last_refreshed', NOW()
        );
    END IF;
    
    RETURN result;
END;
$$ LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp;

COMMENT ON FUNCTION get_about_statistics() IS 
'Get about page statistics as JSON. Returns cached values from materialized view.';

-- Analyze the materialized view
ANALYZE mv_about_statistics;

-- Grant permissions (adjust based on your security requirements)
-- GRANT SELECT ON mv_about_statistics TO authenticated;
-- GRANT EXECUTE ON FUNCTION refresh_about_statistics() TO service_role;
-- GRANT EXECUTE ON FUNCTION get_about_statistics() TO authenticated;

-- Log migration completion
DO $$
DECLARE
    stats_record RECORD;
BEGIN
    -- Get the statistics for logging
    SELECT * INTO stats_record FROM mv_about_statistics LIMIT 1;
    
    RAISE NOTICE '==============================================';
    RAISE NOTICE 'Migration 007: About Statistics Materialized View';
    RAISE NOTICE '==============================================';
    RAISE NOTICE 'Created: mv_about_statistics';
    RAISE NOTICE 'Functions: refresh_about_statistics(), get_about_statistics()';
    RAISE NOTICE '----------------------------------------------';
    IF stats_record IS NOT NULL THEN
        RAISE NOTICE 'Current Statistics:';
        RAISE NOTICE '  - Companies: %', stats_record.company_count;
        RAISE NOTICE '  - Industries: %', stats_record.industry_count;
        RAISE NOTICE '  - Latest Data: %', stats_record.latest_update_date;
    END IF;
    RAISE NOTICE '----------------------------------------------';
    RAISE NOTICE 'Next steps:';
    RAISE NOTICE '1. Add refresh_about_statistics() to daily data pipeline';
    RAISE NOTICE '2. Add gRPC endpoint to query mv_about_statistics';
    RAISE NOTICE '3. Update frontend to use new endpoint';
    RAISE NOTICE '==============================================';
END $$;

