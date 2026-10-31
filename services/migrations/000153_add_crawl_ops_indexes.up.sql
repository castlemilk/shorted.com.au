-- 000153: indexes for the admin housing-crawl debugging tools (admin MCP, crawl:read / crawl:operate).
--
--   idx_crawl_ingest_receipts_job_id   the receipts of one job: a lookup on split_part(key, ':', 1), the
--                                      job id of a <job_id>:<attempt>:<source> key. Without it every job
--                                      trail scans the receipts table.
--   idx_crawl_dispatch_run_id          a smoke run's ledger rows, by run id.
--   idx_crawl_dispatch_open_suburb     the open ledger rows of one catalog suburb, by its slug. Partial on
--                                      closed_at IS NULL, the predicate every open-dispatch read uses.
--
-- These tables are small (the ledger and the receipts are pruned after 14 days), so a plain build is
-- short. The repo does not use CONCURRENTLY in migrations: migration 000022 records that it cannot run
-- inside golang-migrate's transaction. The build is therefore guarded like 000150 to 000152: one
-- transaction, and a lock_timeout so a build blocked behind a long write fails the step instead of
-- queueing behind it. Replay-safe: IF NOT EXISTS touches nothing when the index is there.
--
-- A failed build leaves an INVALID index, which IF NOT EXISTS would then skip. If a deploy fails here,
-- check pg_index.indisvalid for these names and DROP INDEX any invalid one before re-running.
BEGIN;
SET LOCAL lock_timeout = '15s';

CREATE INDEX IF NOT EXISTS idx_crawl_ingest_receipts_job_id
    ON crawl_ingest_receipts (split_part(key, ':', 1));

CREATE INDEX IF NOT EXISTS idx_crawl_dispatch_run_id
    ON crawl_dispatch (run_id);

CREATE INDEX IF NOT EXISTS idx_crawl_dispatch_open_suburb
    ON crawl_dispatch ((lower(replace(suburb, ' ', '-'))))
    WHERE closed_at IS NULL;

COMMIT;
