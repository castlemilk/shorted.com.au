-- Per-table autovacuum thresholds for the three append-mostly tables that the
-- global defaults never vacuum or analyze (DBP-04, 2026-10-21 review).
--
-- The global triggers scale with table size: an insert-driven vacuum after
-- 1,000 + 20% of the table's rows, an analyze after 50 + 10%. Measured on prod
-- (pg_stat_user_tables, statistics since 2026-07-23, read 2026-10-21):
--
--   shorts             2.29M rows, ~650 inserts a trading day: autovacuum 0,
--                      autoanalyze 0 in 90 days; 58,268 inserts since the last
--                      vacuum, 62,414 changes since the last analyze; the
--                      triggers are 458k inserts and 229k changes, about once
--                      every one to two years. The planner's DATE histogram
--                      ends at 2026-06-12 (the June hand ANALYZE) while the
--                      data runs to 2026-10-15; 90.4% of pages all-visible.
--   news_articles      432k rows: autovacuum 0; 15,247 dead tuples; only 55.6%
--                      of pages all-visible, so its index-only scans fetch the
--                      heap for 44% of the table.
--   asx_announcements  432k rows: autovacuum 0; 71.1% of pages all-visible.
--
-- An index-only scan is only index-only on all-visible pages, which is what
-- the short-interest chart index (000141) depends on. These thresholds make
-- vacuum and analyze run on a few thousand new rows at a time, each pass
-- seconds long:
--   shorts             vacuum after 5,000 inserts (about 8 trading days),
--                      analyze after 2,000 changes (about 3), independent of
--                      table size.
--   news_articles      vacuum, insert-vacuum and analyze after 2% (~8.6k rows).
--   asx_announcements  insert-vacuum and analyze after 2% (~8.6k rows).
--
-- Each ALTER runs only when the table does not already carry these settings,
-- so a replay reads the catalog and takes no lock. When it does run, ALTER
-- TABLE ... SET (storage parameters) takes a SHARE UPDATE EXCLUSIVE lock,
-- which blocks no read or write (only VACUUM, ANALYZE and CREATE INDEX
-- CONCURRENTLY on that table); lock_timeout bounds the wait behind one.
--
-- Hand-applied (prod does not run `migrate up`):
--   task db:prod:apply FILE=services/migrations/000144_autovacuum_append_tables.up.sql CONFIRM=prod
-- It sets thresholds for the future; the one-off catch-up pass is an owner
-- action (VACUUM cannot run in a transaction): VACUUM (ANALYZE) on the three
-- tables, see the 2026-10-21 database review.

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $migration$
DECLARE
    t record;
BEGIN
    FOR t IN
        SELECT * FROM (VALUES
            ('shorts', ARRAY[
                'autovacuum_vacuum_insert_threshold=5000',
                'autovacuum_vacuum_insert_scale_factor=0',
                'autovacuum_analyze_threshold=2000',
                'autovacuum_analyze_scale_factor=0']),
            ('news_articles', ARRAY[
                'autovacuum_vacuum_scale_factor=0.02',
                'autovacuum_vacuum_insert_scale_factor=0.02',
                'autovacuum_analyze_scale_factor=0.02']),
            ('asx_announcements', ARRAY[
                'autovacuum_vacuum_insert_scale_factor=0.02',
                'autovacuum_analyze_scale_factor=0.02'])
        ) AS v(tbl, opts)
    LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_class
            WHERE oid = format('public.%I', t.tbl)::regclass
              AND COALESCE(reloptions, '{}'::text[]) @> t.opts
        ) THEN
            EXECUTE format('ALTER TABLE public.%I SET (%s)', t.tbl, array_to_string(t.opts, ', '));
            RAISE NOTICE '000144: set % on %', array_to_string(t.opts, ', '), t.tbl;
        END IF;
    END LOOP;
END
$migration$;

COMMIT;
