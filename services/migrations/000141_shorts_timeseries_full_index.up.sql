-- A covering index that answers the short-interest chart without the heap
-- (DBP-02, 2026-10-21 database review).
--
-- GetStockData (postgres.go) averages REPORTED_SHORT_POSITIONS and
-- TOTAL_PRODUCT_IN_ISSUE beside the percentage, but idx_shorts_timeseries_covering
-- (000022) INCLUDEs only the percentage, so every chart is an Index Scan that
-- visits a heap page per report date. Measured on prod since 2026-07-23
-- (pg_stat_statements): the bucketed chart query ran 111,780 times at 646 ms
-- mean (max 45.9 s), reading 316 blocks per call from outside shared_buffers;
-- the chart statements were 14% of all database time and 24% of all disk
-- reads. This index carries all three values, so the chart, its COUNT, the
-- full-resolution read, the top-shorts sparklines and GetStock can all be
-- index-only scans (once the visibility map is set: see 000144 and its
-- owner action, VACUUM (ANALYZE) shorts).
--
-- It has the same keys as idx_shorts_product_code_date (000001) and
-- idx_shorts_timeseries_covering (000022), 75 MB + 95 MB on prod; 000142 and
-- 000143 drop those two once this one is valid and in use.
--
-- ONE statement per file, on purpose: CREATE INDEX CONCURRENTLY cannot run in
-- a transaction block, and `migrate up` sends a file as one query string, which
-- Postgres runs as an implicit transaction when it holds more than one
-- statement. scripts/prod-psql-classify.mjs classifies this file `session`, so
-- `task db:prod:apply` runs it with a session-level statement_timeout = 0.
--
-- Hand-applied (prod does not run `migrate up`), in a quiet window, not while
-- the daily ASIC sync writes shorts:
--   task db:prod:apply FILE=services/migrations/000141_shorts_timeseries_full_index.up.sql CONFIRM=prod
-- A concurrent build reads the table twice and blocks no reader or writer;
-- expect well under a few minutes for 2.29M rows (about 130 MB of index).
-- Replay-safe (IF NOT EXISTS), with one trap: a build that fails or is
-- cancelled leaves an INVALID index of this name, which IF NOT EXISTS then
-- skips. After applying, this must return true:
--   SELECT indisvalid FROM pg_index WHERE indexrelid = 'idx_shorts_timeseries_full'::regclass;
-- If it returns false, apply the down file and apply this one again.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_shorts_timeseries_full
    ON shorts ("PRODUCT_CODE", "DATE" DESC)
    INCLUDE ("PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS",
             "REPORTED_SHORT_POSITIONS", "TOTAL_PRODUCT_IN_ISSUE");
