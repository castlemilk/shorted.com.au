-- 000153: indexes for the admin housing-crawl debugging tools (admin MCP, crawl:read / crawl:operate).
--
--   idx_crawl_ingest_receipts_job_id   the receipts of one job: a lookup on split_part(key, ':', 1), the
--                                      job id of a <job_id>:<attempt>:<source> key. Without it every job
--                                      trail scans the receipts table.
--   idx_crawl_dispatch_run_id          a smoke run's ledger rows, by run id.
--   idx_crawl_dispatch_open_suburb     the open ledger rows of one catalog suburb, by its slug. Partial on
--                                      closed_at IS NULL, the predicate every open-dispatch read uses.
--
-- LOCK-FREE ON REPLAY. Prod replays every allowlisted migration on every deploy
-- (.github/workflows/terraform-deploy.yml). CREATE INDEX IF NOT EXISTS takes a SHARE lock on the
-- table before it checks the name, so a replay would wait behind open ingest writes (up to the
-- lock_timeout) even when the index already exists. Each index is therefore created only when the
-- catalog does not already hold a VALID index of that name. The check reads pg_index and takes no
-- lock on the tables, so a replay with the indexes present touches nothing and cannot block a writer.
--
-- The tables are small (the ledger and the receipts are pruned after 14 days), so the first build is
-- short. The repo does not use CONCURRENTLY in migrations: migration 000022 records that it cannot run
-- inside golang-migrate's transaction. The first build runs in this transaction under lock_timeout 15s,
-- so a build blocked behind a long write fails the step instead of queueing behind it.
--
-- A build that failed midway can leave an INVALID index of the same name. The guard then drops that
-- leftover (catalog-only when there is nothing to drop) and builds again.
BEGIN;
SET LOCAL lock_timeout = '15s';

DO $m153_receipts$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_index x ON x.indexrelid = c.oid
    WHERE c.relname = 'idx_crawl_ingest_receipts_job_id' AND x.indisvalid
  ) THEN
    DROP INDEX IF EXISTS idx_crawl_ingest_receipts_job_id;
    CREATE INDEX idx_crawl_ingest_receipts_job_id
      ON crawl_ingest_receipts (split_part(key, ':', 1));
  END IF;
END
$m153_receipts$;

DO $m153_run$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_index x ON x.indexrelid = c.oid
    WHERE c.relname = 'idx_crawl_dispatch_run_id' AND x.indisvalid
  ) THEN
    DROP INDEX IF EXISTS idx_crawl_dispatch_run_id;
    CREATE INDEX idx_crawl_dispatch_run_id ON crawl_dispatch (run_id);
  END IF;
END
$m153_run$;

DO $m153_suburb$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_index x ON x.indexrelid = c.oid
    WHERE c.relname = 'idx_crawl_dispatch_open_suburb' AND x.indisvalid
  ) THEN
    DROP INDEX IF EXISTS idx_crawl_dispatch_open_suburb;
    CREATE INDEX idx_crawl_dispatch_open_suburb
      ON crawl_dispatch ((lower(replace(suburb, ' ', '-'))))
      WHERE closed_at IS NULL;
  END IF;
END
$m153_suburb$;

COMMIT;
