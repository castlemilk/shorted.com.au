-- prod-data-api-progress.sql: is anything in public being vacuumed, analyzed or indexed? ZERO ROWS = go.
--
-- An optional second pre-check for services/migrations/000138_harden_data_api_grants.up.sql,
-- run right after scripts/prod-data-api-precheck.sql while prod runs a
-- PostgreSQL release before 15.9 (it ran 15.6 on 2026-10-21). Read-only, plain
-- SQL, so prod-psql.sh's probe mode accepts it:
--
--   task db:prod:psql -- -P pager=off -f scripts/prod-data-api-progress.sql
--
-- Why: VACUUM and ANALYZE write a table's statistics (and VACUUM its frozen
-- transaction horizon) into its pg_class row in place, and CREATE INDEX sets
-- relhasindex the same way. Before 15.9, an in-place update that lands while
-- another transaction is updating the same pg_class row, as each of step 1's
-- REVOKEs does, can be lost when that transaction commits. Step 1 takes a
-- fraction of a second, so the chance is small, but this rules it out. The
-- lasting fix is the Supabase minor-version upgrade.
--
-- One row per vacuum, analyze or index build in progress in this database on
-- a relation in public. A row with no relation is one this role cannot see
-- (it needs pg_read_all_stats, which postgres had on 2026-10-21): wait for it
-- too. Autovacuum workers are counted here, unlike in the pre-check: what
-- matters is the in-place write, not a lock.

WITH progress AS (
    SELECT 'VACUUM' AS command, pid, datid, relid, phase FROM pg_stat_progress_vacuum
    UNION ALL
    SELECT 'ANALYZE', pid, datid, relid, phase FROM pg_stat_progress_analyze
    UNION ALL
    SELECT command, pid, datid, relid, phase FROM pg_stat_progress_create_index
)
SELECT p.command, p.pid, p.relid::regclass AS relation, p.phase
  FROM progress p
  LEFT JOIN pg_class c ON c.oid = p.relid
 WHERE p.datid = (SELECT oid FROM pg_database WHERE datname = current_database())
   AND (c.oid IS NULL OR c.relnamespace = 'public'::regnamespace)
 ORDER BY p.pid;
