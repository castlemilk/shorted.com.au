-- Backfill website URLs from a staging table loaded from CSV
-- 
-- Usage:
-- 1. Create a temporary table with stock_code and website from the CSV
-- 2. Run the UPDATE query below
--
-- This can be run via psql or any SQL client connected to the database.

-- Example: First load data from CSV into a temp table
-- (This would typically be done via \copy or COPY command)
/*
CREATE TEMP TABLE website_import (
    company_name TEXT,
    industry TEXT,
    listing_date TEXT,
    market_cap TEXT,
    company_name_2 TEXT,
    address TEXT,
    summary TEXT,
    details TEXT,
    website TEXT,
    stock_code TEXT,
    links TEXT,
    images TEXT,
    company_logo_link TEXT,
    gcsUrl TEXT
);

-- Load from CSV (adjust path as needed)
\copy website_import FROM 'analysis/data/asx_company_metadata_final.csv' WITH CSV HEADER;
*/

-- Update company-metadata with websites where missing
-- This query updates only where current website is NULL or empty
UPDATE "company-metadata" cm
SET website = wi.website
FROM (
    -- Subquery to get valid websites from import
    SELECT stock_code, website
    FROM website_import
    WHERE website IS NOT NULL 
      AND website != '' 
      AND website LIKE 'http%'
) wi
WHERE cm.stock_code = wi.stock_code
  AND (cm.website IS NULL OR cm.website = '');

-- Check results
SELECT 
    COUNT(*) FILTER (WHERE website IS NOT NULL AND website != '') as with_website,
    COUNT(*) FILTER (WHERE website IS NULL OR website = '') as without_website,
    COUNT(*) as total
FROM "company-metadata";
