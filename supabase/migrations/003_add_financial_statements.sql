-- Migration: Add Financial Statements Storage
-- Stores detailed income statements, balance sheets, and cash flow statements from Yahoo Finance

-- Add financial statements column to company-metadata table
ALTER TABLE "company-metadata"
ADD COLUMN IF NOT EXISTS financial_statements JSONB DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS financial_statements_updated_at TIMESTAMP WITH TIME ZONE;

-- Create index for querying financial statements
CREATE INDEX IF NOT EXISTS idx_company_metadata_financial_statements 
ON "company-metadata" USING GIN (financial_statements);

-- Create index for last updated timestamp
CREATE INDEX IF NOT EXISTS idx_company_metadata_financial_statements_updated 
ON "company-metadata"(financial_statements_updated_at DESC);

-- Add comments for documentation
COMMENT ON COLUMN "company-metadata".financial_statements IS 
'Complete financial statements from Yahoo Finance: Income Statement, Balance Sheet, Cash Flow (annual & quarterly)';

COMMENT ON COLUMN "company-metadata".financial_statements_updated_at IS 
'Timestamp of last financial statements update';

-- Create a view for companies with recent financial data
CREATE OR REPLACE VIEW companies_with_financials AS
SELECT 
    stock_code,
    company_name,
    financial_statements->'annual'->'income_statement' as annual_income_statement,
    financial_statements->'annual'->'balance_sheet' as annual_balance_sheet,
    financial_statements->'annual'->'cash_flow' as annual_cash_flow,
    financial_statements_updated_at,
    (financial_statements->>'last_updated')::timestamp as data_timestamp
FROM "company-metadata"
WHERE financial_statements IS NOT NULL 
  AND financial_statements != '{}'::jsonb
ORDER BY financial_statements_updated_at DESC;

-- Example queries:

-- Get latest revenue for all companies:
-- SELECT 
--     stock_code,
--     company_name,
--     (financial_statements->'annual'->'income_statement'->
--      (jsonb_object_keys(financial_statements->'annual'->'income_statement') 
--       ORDER BY jsonb_object_keys DESC LIMIT 1)->>'Total Revenue')::numeric as latest_revenue
-- FROM "company-metadata"
-- WHERE financial_statements->'annual'->'income_statement' IS NOT NULL;

-- Get companies by revenue (descending):
-- SELECT 
--     stock_code,
--     company_name,
--     (SELECT value->>'Total Revenue' 
--      FROM jsonb_each(financial_statements->'annual'->'income_statement') 
--      ORDER BY key DESC LIMIT 1)::numeric / 1000000000 as revenue_billions
-- FROM "company-metadata"
-- WHERE financial_statements->'annual'->'income_statement' IS NOT NULL
-- ORDER BY revenue_billions DESC NULLS LAST;

