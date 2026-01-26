-- Remove key_metrics columns from company-metadata table

DROP INDEX IF EXISTS idx_company_metadata_pe_ratio;
DROP INDEX IF EXISTS idx_company_metadata_market_cap;

ALTER TABLE "company-metadata"
DROP COLUMN IF EXISTS key_metrics_updated_at;

ALTER TABLE "company-metadata"
DROP COLUMN IF EXISTS key_metrics;

