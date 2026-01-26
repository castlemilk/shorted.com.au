-- Rollback: Drop enrichment jobs table

DROP INDEX IF EXISTS idx_enrichment_jobs_stock_code;
DROP INDEX IF EXISTS idx_enrichment_jobs_status;
DROP TABLE IF EXISTS "enrichment-jobs";

