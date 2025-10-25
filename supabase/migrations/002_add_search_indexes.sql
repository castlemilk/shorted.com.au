-- Add indexes for search functionality optimization
-- This migration adds indexes to improve search performance for stock lookups

-- Index for PRODUCT_CODE searches (exact matches)
CREATE INDEX IF NOT EXISTS idx_shorts_product_code_search 
ON shorts("PRODUCT_CODE");

-- Index for PRODUCT name searches (partial matches)
CREATE INDEX IF NOT EXISTS idx_shorts_product_name_search 
ON shorts("PRODUCT");

-- Composite index for both PRODUCT_CODE and PRODUCT searches with ILIKE
-- This will help with the WHERE clause: "PRODUCT_CODE" ILIKE $1 OR "PRODUCT" ILIKE $1
CREATE INDEX IF NOT EXISTS idx_shorts_search_composite 
ON shorts("PRODUCT_CODE", "PRODUCT");

-- Index for sorting by PRODUCT_CODE (used in ORDER BY)
CREATE INDEX IF NOT EXISTS idx_shorts_product_code_sort 
ON shorts("PRODUCT_CODE" ASC);

-- Index for the most recent data per product (for DISTINCT queries)
CREATE INDEX IF NOT EXISTS idx_shorts_latest_per_product 
ON shorts("PRODUCT_CODE", "DATE" DESC);

-- Partial index for non-null percentage values (commonly filtered)
CREATE INDEX IF NOT EXISTS idx_shorts_percentage_not_null 
ON shorts("PRODUCT_CODE", "PRODUCT") 
WHERE "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" IS NOT NULL;

-- Text search index for PRODUCT names (for better ILIKE performance)
-- This creates a trigram index for fuzzy text matching
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_shorts_product_trgm 
ON shorts USING gin("PRODUCT" gin_trgm_ops);

-- Index for PRODUCT_CODE trigram search (for partial symbol matches)
CREATE INDEX IF NOT EXISTS idx_shorts_product_code_trgm 
ON shorts USING gin("PRODUCT_CODE" gin_trgm_ops);

-- Add comments for documentation
COMMENT ON INDEX idx_shorts_product_code_search IS 'Index for exact PRODUCT_CODE lookups';
COMMENT ON INDEX idx_shorts_product_name_search IS 'Index for PRODUCT name searches';
COMMENT ON INDEX idx_shorts_search_composite IS 'Composite index for search queries';
COMMENT ON INDEX idx_shorts_product_code_sort IS 'Index for sorting by PRODUCT_CODE';
COMMENT ON INDEX idx_shorts_latest_per_product IS 'Index for getting latest data per product';
COMMENT ON INDEX idx_shorts_percentage_not_null IS 'Partial index for non-null percentage values';
COMMENT ON INDEX idx_shorts_product_trgm IS 'Trigram index for fuzzy PRODUCT name matching';
COMMENT ON INDEX idx_shorts_product_code_trgm IS 'Trigram index for fuzzy PRODUCT_CODE matching';
