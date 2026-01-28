-- Backfill missing company-metadata entries from shorts table
-- This script creates metadata entries for all stocks in shorts that don't have metadata yet

-- First, let's see what we're dealing with
SELECT 
    'Stocks in shorts table' as metric,
    COUNT(DISTINCT "PRODUCT_CODE") as count
FROM shorts
UNION ALL
SELECT 
    'Stocks in company-metadata' as metric,
    COUNT(*) as count
FROM "company-metadata"
UNION ALL
SELECT 
    'Stocks missing metadata' as metric,
    COUNT(*) as count
FROM (
    SELECT DISTINCT s."PRODUCT_CODE"
    FROM shorts s
    LEFT JOIN "company-metadata" m ON s."PRODUCT_CODE" = m.stock_code
    WHERE m.stock_code IS NULL
) missing;

-- Function to clean company names (remove ORDINARY, LTD, etc.)
CREATE OR REPLACE FUNCTION clean_company_name(name TEXT) RETURNS TEXT AS $$
DECLARE
    result TEXT;
BEGIN
    result := UPPER(name);
    -- Remove common suffixes
    result := REGEXP_REPLACE(result, '\s+ORDINARY$', '', 'i');
    result := REGEXP_REPLACE(result, '\s+ORD$', '', 'i');
    result := REGEXP_REPLACE(result, '\s+CDI\s+\d+:\d+$', '', 'i');
    result := REGEXP_REPLACE(result, '\s+CDI$', '', 'i');
    result := REGEXP_REPLACE(result, '\s+LIMITED$', '', 'i');
    result := REGEXP_REPLACE(result, '\s+LTD$', '', 'i');
    result := REGEXP_REPLACE(result, '\s+CORPORATION$', '', 'i');
    result := REGEXP_REPLACE(result, '\s+CORP$', '', 'i');
    result := REGEXP_REPLACE(result, '\s+INC$', '', 'i');
    result := REGEXP_REPLACE(result, '\s+PLC$', '', 'i');
    -- Title case
    result := INITCAP(LOWER(TRIM(result)));
    RETURN result;
END;
$$ LANGUAGE plpgsql;

-- Insert missing metadata entries
-- Using the most recent product name from shorts table
INSERT INTO "company-metadata" (stock_code, company_name, enrichment_status)
SELECT 
    latest.product_code,
    clean_company_name(latest.product_name),
    'pending'
FROM (
    SELECT DISTINCT ON (s."PRODUCT_CODE")
        s."PRODUCT_CODE" as product_code,
        s."PRODUCT" as product_name
    FROM shorts s
    LEFT JOIN "company-metadata" m ON s."PRODUCT_CODE" = m.stock_code
    WHERE m.stock_code IS NULL
    ORDER BY s."PRODUCT_CODE", s."DATE" DESC
) latest
ON CONFLICT (stock_code) DO NOTHING;

-- Show results
SELECT 
    'After backfill - Stocks in company-metadata' as metric,
    COUNT(*) as count
FROM "company-metadata";

-- Drop the helper function
DROP FUNCTION IF EXISTS clean_company_name(TEXT);

-- Show a sample of newly created entries
SELECT stock_code, company_name, enrichment_status
FROM "company-metadata"
WHERE enrichment_status = 'pending'
ORDER BY stock_code
LIMIT 20;
