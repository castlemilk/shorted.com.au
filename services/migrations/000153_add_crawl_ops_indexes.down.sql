-- Reverses 000153. Drops only the three indexes that migration creates.
BEGIN;
SET LOCAL lock_timeout = '15s';

DROP INDEX IF EXISTS idx_crawl_dispatch_open_suburb;
DROP INDEX IF EXISTS idx_crawl_dispatch_run_id;
DROP INDEX IF EXISTS idx_crawl_ingest_receipts_job_id;

COMMIT;
