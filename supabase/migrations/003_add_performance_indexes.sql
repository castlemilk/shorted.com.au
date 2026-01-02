-- Add performance indexes for treemap and top shorts queries
-- This migration adds critical indexes to optimize complex analytical queries

-- Index for date-based filtering with percentage (used in all analytical queries)
-- This covers the common pattern: WHERE "DATE" >= (MAX - INTERVAL) AND PERCENT > 0
CREATE INDEX IF NOT EXISTS idx_shorts_date_product_percent 
ON shorts("DATE" DESC, "PRODUCT_CODE", "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS");

-- Composite index for company metadata joins (stock_code + industry)
-- Optimizes JOIN on stock_code and PARTITION BY industry operations
CREATE INDEX IF NOT EXISTS idx_company_metadata_stock_industry 
ON "company-metadata"(stock_code, industry);

-- Index for latest date queries (used in MAX(DATE) subqueries)
-- Specialized index for finding the most recent data point
CREATE INDEX IF NOT EXISTS idx_shorts_date_desc_only
ON shorts("DATE" DESC NULLS LAST);

-- Composite index for percentage-based filtering with date
-- Optimizes queries that filter on both percentage and date
CREATE INDEX IF NOT EXISTS idx_shorts_percent_date
ON shorts("PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" DESC, "DATE" DESC)
WHERE "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" IS NOT NULL 
  AND "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" > 0;

-- Covering index for top shorts time series queries
-- Includes all columns needed for the time series data fetch
CREATE INDEX IF NOT EXISTS idx_shorts_timeseries_covering
ON shorts("PRODUCT_CODE", "DATE" DESC)
INCLUDE ("PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS")
WHERE "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" > 0;

-- Index specifically for treemap window function queries
-- Optimizes the PARTITION BY PRODUCT_CODE ORDER BY DATE pattern
CREATE INDEX IF NOT EXISTS idx_shorts_product_date_for_windows
ON shorts("PRODUCT_CODE", "DATE" DESC, "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS");

-- Add comments for documentation
COMMENT ON INDEX idx_shorts_date_product_percent IS 'Composite index for date filtering with product and percentage';
COMMENT ON INDEX idx_company_metadata_stock_industry IS 'Composite index for joining company metadata with industry partitioning';
COMMENT ON INDEX idx_shorts_date_desc_only IS 'Specialized index for MAX(DATE) queries';
COMMENT ON INDEX idx_shorts_percent_date IS 'Partial index for percentage-based filtering with date';
COMMENT ON INDEX idx_shorts_timeseries_covering IS 'Covering index for time series queries';
COMMENT ON INDEX idx_shorts_product_date_for_windows IS 'Optimized index for window function queries in treemap';

-- Analyze tables to update statistics for query planner
ANALYZE shorts;
ANALYZE "company-metadata";

