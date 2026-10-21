-- prod-data-api-precheck.sql: is now a quiet moment to apply 000138? ZERO ROWS = go.
--
-- Read-only, plain SQL, so prod-psql.sh's probe mode accepts it and runs it
-- inside BEGIN READ ONLY ... ROLLBACK:
--
--   task db:prod:psql -- -P pager=off -f scripts/prod-data-api-precheck.sql
--
-- One row per other backend that applying
-- services/migrations/000138_harden_data_api_grants.up.sql would wait for,
-- and why:
--   refresh         a materialized-view refresh is running
--   catalog_writer  it holds SHARE ROW EXCLUSIVE, EXCLUSIVE or ACCESS EXCLUSIVE
--                   on a relation in public (a REFRESH, TRUNCATE or ALTER in
--                   flight); 000138's privileges step refuses to start while
--                   one does
--   rls_wait        a transaction open for more than 3s holds a lock on a table
--                   whose row level security is still off; ENABLE ROW LEVEL
--                   SECURITY on that table would wait 3s, holding up the
--                   table's new readers, and then defer it
-- If a row appears, wait for that backend to finish and run this again.
-- The same query is in 000138's header and in
-- docs/operations/supabase-data-api.md; data_api_grants.test.mjs keeps the
-- three copies identical.

WITH held AS (
    SELECT l.pid,
           string_agg(DISTINCT c.relname::text, ', ' ORDER BY c.relname::text)
               FILTER (WHERE l.mode IN ('ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
                         AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')) AS exclusive_on,
           string_agg(DISTINCT c.relname::text, ', ' ORDER BY c.relname::text)
               FILTER (WHERE c.relkind IN ('r', 'p') AND NOT c.relrowsecurity) AS rls_off
      FROM pg_locks l
      JOIN pg_class c ON c.oid = l.relation
     WHERE l.locktype = 'relation'
       AND l.granted
       AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
       AND c.relnamespace = 'public'::regnamespace
     GROUP BY l.pid
),
backends AS (
    SELECT a.pid, a.usename, a.application_name, a.state,
           date_trunc('second', now() - a.xact_start) AS xact_age,
           concat_ws(', ',
               CASE WHEN a.state = 'active'
                     AND a.query ~* 'refresh_[a-z_]+_views[[:space:]]*[(]|REFRESH[[:space:]]+MATERIALIZED[[:space:]]+VIEW'
                    THEN 'refresh' END,
               CASE WHEN h.exclusive_on IS NOT NULL THEN 'catalog_writer' END,
               CASE WHEN h.rls_off IS NOT NULL AND a.xact_start < now() - interval '3 seconds'
                    THEN 'rls_wait' END) AS why,
           coalesce(h.exclusive_on, h.rls_off) AS public_relations,
           left(regexp_replace(a.query, '[[:space:]]+', ' ', 'g'), 80) AS query
      FROM pg_stat_activity a
      LEFT JOIN held h ON h.pid = a.pid
     WHERE a.pid <> pg_backend_pid()
       AND a.datname = current_database()
       AND a.backend_type IS DISTINCT FROM 'autovacuum worker'
)
SELECT pid, usename, application_name, state, xact_age, why, public_relations, query
  FROM backends
 WHERE why <> ''
 ORDER BY xact_age DESC NULLS LAST, pid;
