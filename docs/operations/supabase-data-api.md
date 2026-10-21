# Supabase Data API: closed, and how to keep it closed

Prod is a Supabase project, so PostgREST (the Data API) serves schema `public`
to anyone holding the project's anon key, with whatever the `anon` and
`authenticated` roles can reach. Nothing in this product uses it: every
service, job and collector connects as `postgres`, which owns every object in
`public` and has `BYPASSRLS`.

`services/migrations/000138_harden_data_api_grants.up.sql` closes it. Its
header is the full record; this page is the procedure.

## What 000138 does

- Revokes everything `PUBLIC`, `anon` and `authenticated` hold on every table,
  view, materialized view, foreign table, sequence and routine in `public`.
- Stops `postgres`'s default privileges from granting new objects to `anon`
  and `authenticated` (its entries for `public` and its schema-less ones), and
  stops new functions being executable by `PUBLIC`.
- Enables row level security on every table, with no policy and no FORCE.

The backend sees no change: an owner keeps its own privileges, RLS without
FORCE never applies to an owner, and `postgres` has `BYPASSRLS` anyway.

## Applying it, or re-closing drift

Nothing re-closes the Data API on its own while the **Deploy Infrastructure**
workflow is disabled (it has been since October 2026). 000138 is the last file
that workflow replays, so once it runs again every deploy re-closes what a
replayed or hand-applied migration opened. Until then, run the loop below by
hand: pre-check, apply, check, and repeat until the check returns zero rows.

**Apply it only with psql, statement by statement**: `task db:prod:apply`
(below), or `psql -X -v ON_ERROR_STOP=1 -f` (`-X`, because an `AUTOCOMMIT off`
in a `~/.psqlrc` would wrap the file in one transaction). Never paste it into
the dashboard's SQL editor or send it through the Management API or Supabase
MCP (`execute_sql`, `apply_migration`): each sends the file as ONE query, so
step 1 commits and step 2 fails with `invalid_transaction_termination`,
leaving row level security off. If that has happened, the privileges are
closed and no table has changed: run the loop below.

### When

Outside every materialized-view refresh. Each one holds its views until it
ends, and a REVOKE of a view being refreshed would wait for it:

| Refresh | When | Typical length |
|---|---|---|
| `refresh_all_materialized_views()` | the ASIC sync, from 10:00 UTC | mean 191s, up to 7 min |
| `refresh_housing_materialized_views()` | about 11 times a day, no fixed time | mean 21s |
| `refresh_strategy_views()` | `shorted picks`, 13:30 UTC weekdays, and the end of the nightly run from 15:00 UTC | mean 31s |
| `refresh_register_materialized_views()` | the end of `shorted influence -mode register-resolve` | mean 6s |
| `refresh_aec_donations_materialized_views()` | the end of `shorted influence -mode aec-donations` | mean 13s |

That table is the schedule, not the gate. The pre-check is the gate: it also
sees catalog writers the table leaves out, such as the market-data sync's
`REFRESH MATERIALIZED VIEW CONCURRENTLY mv_stock_price_coverage`,
`refresh_stock_price_coverage()`, and the AEC donations and register loads,
which TRUNCATE inside their transaction. The housing refresh keeps no schedule
either, so always run the pre-check right before applying.

### 1. Pre-check (read-only; zero rows = go)

```bash
task db:prod:psql -- -P pager=off -f scripts/prod-data-api-precheck.sql
```

It returns one row per backend the apply would wait for, with why:
`refresh` (a refresh is running), `catalog_writer` (a REFRESH, TRUNCATE or
ALTER holds SHARE ROW EXCLUSIVE, EXCLUSIVE or ACCESS EXCLUSIVE on a relation in
`public`; step 1 refuses to start while one does) or `rls_wait` (a transaction
open for more than 3s holds a lock on a table whose row level security is still
off; that table would wait 3s and be deferred). If a row appears, wait for it
and run the pre-check again. The file runs this query, which is also in
000138's header (`data_api_grants.test.mjs` keeps the copies identical):

```sql
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
```

### 1b. Optional while prod runs PostgreSQL before 15.9: nothing being vacuumed, analyzed or indexed

Prod ran 15.6 on 2026-10-21. VACUUM and ANALYZE write a table's statistics
(and VACUUM its frozen transaction horizon) into its `pg_class` row in place,
and CREATE INDEX sets `relhasindex` the same way. Before 15.9 such a write that
lands while another transaction updates the same row, as each of step 1's
REVOKEs does, can be lost. Step 1 takes a fraction of a second, so the chance
is small, but it costs one read-only query to rule out, right after the
pre-check (zero rows = go; autovacuum counts here):

```bash
task db:prod:psql -- -P pager=off -f scripts/prod-data-api-progress.sql
```

A row names the command, its backend and the table; wait for it and run both
checks again. The lasting fix is the Supabase minor-version upgrade, an owner
action.

### 2. Apply

```bash
task db:prod:apply FILE=services/migrations/000138_harden_data_api_grants.up.sql CONFIRM=prod
```

Expected output:

- `prod-psql` warns that the file manages its own transactions and falls back
  to a session-level `statement_timeout = 0`, undone by `RESET ALL`. That is
  expected, as for 000132.
- `NOTICE: 000138: revoked PUBLIC/anon/authenticated on N relation(s) and M routine(s); closed K default-privilege entries`.
- `NOTICE: 000138: left as is (postgres cannot change them): default privileges FOR ROLE supabase_admin IN SCHEMA public (...)`.
  Expected: only `supabase_admin` or a superuser can change those.
- `NOTICE: 000138: row level security enabled on T table(s)`, and exit 0.

### 3. Check (zero rows = closed)

```bash
task db:prod:psql -- -P pager=off -f scripts/prod-data-api-check.sql
```

If it returns rows, go back to step 1.

### If it stops, or leaves something

- **`ERROR: 000138: a REFRESH, TRUNCATE or ALTER is in flight in schema public, so nothing was changed: pid ...`**
  (`object_in_use`). Step 1 looked in `pg_locks` before its first REVOKE and
  found a backend rewriting a catalog row the REVOKE would wait for. Nothing
  changed and psql stopped before step 2. Wait for that backend (the message
  names its query and relations) and start again from the pre-check.
- **`ERROR: canceling statement due to lock timeout`, `CONTEXT: while updating tuple ... in relation "pg_class"`** (or `"pg_attribute"`).
  The backstop: something the look cannot see held a row step 1 rewrites for
  more than 3s: a refresh that started just after the look, an ALTER that takes
  only SHARE UPDATE EXCLUSIVE but rewrites such a row (`ALTER TABLE ... SET`
  with storage parameters, or `SET STATISTICS` on a column with a column grant;
  `public` had none on 2026-10-21), a concurrent GRANT, CREATE OR REPLACE
  FUNCTION or ALTER FUNCTION. Step 1 rolled back whole, so again nothing
  changed. Start again from the pre-check.
- **`ERROR: invalid transaction termination`, right after the `revoked ...` NOTICE.**
  The file went in as one query (the dashboard's SQL editor, the Management
  API, Supabase MCP, golang-migrate). Step 1 committed, so the privileges are
  closed; step 2 changed no table. Run the loop again, with `task db:prod:apply`.
- **psql was killed mid-run** (a dropped terminal, `kill -9`). The server does
  not notice at once and finishes the statement it had: in step 2 it goes on
  enabling, or deferring, tables after the client has gone. Before re-running,
  wait until that backend has ended (this returns zero rows), then run the
  check:

  ```bash
  task db:prod:psql -- -P pager=off -c "SELECT pid, state, wait_event, now() - query_start AS running FROM pg_stat_activity WHERE query LIKE '%000138:%' AND pid <> pg_backend_pid()"
  ```

  A Ctrl-C is different: psql cancels the statement, so step 1 rolls back
  whole, and step 2 stops at the table it was on, with the tables before it
  done.
- After either ERROR, `prod-psql` also warns that psql stopped before
  `RESET ALL` ran, so the session-level `statement_timeout = 0` stays on that
  server connection until it closes. That is the wrapper's standard warning
  for a file it runs in session mode, and it is expected here. psql has exited
  by then, which closes the connection; whether Supavisor resets a session
  setting before handing the server connection to another client is
  unverified.
- **`WARNING: 000138: row level security NOT enabled on N table(s) whose lock was not granted within lock_timeout, or whose wait was chosen to break a deadlock: ...`**
  Row level security runs one table per transaction, each waiting at most 3s
  for its ACCESS EXCLUSIVE lock. Only that table's readers wait, and only for
  those 3s. The privileges are already closed; re-run the loop to finish the
  table.
- **A check row the file cannot close.** An object `postgres` cannot act for
  (the file names it in a NOTICE), or an `extension_relation_privilege` row:
  an extension installed into `public` brought a relation in with
  `supabase_admin`'s default privileges, which grant `anon` and `authenticated`
  everything. 000138 never touches extension members; a superuser must revoke
  it, or the extension must move out of `public`.
- **A `default_acl_public_grant` row.** One of `postgres`'s default-privilege
  entries grants `PUBLIC` something: for tables, sequences or functions in
  `public`, or for tables or sequences in every schema. Every new object of
  that kind is then born usable by `anon`, which inherits `PUBLIC`, and row
  level security covers only tables, not views or functions. 000138 revokes
  only `anon` and `authenticated` from those entries, plus `PUBLIC`'s EXECUTE
  from the schema-less one for functions, so a re-run leaves this row. None
  existed on 2026-10-21. Revoke it by hand: put the statement for the entry
  the row names in a file and apply it with
  `task db:prod:apply FILE=<that file> CONFIRM=prod`, then run the check again.

  ```sql
  -- object "FOR ROLE postgres IN SCHEMA public ON TABLES"
  ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
  -- object "FOR ROLE postgres ON TABLES (every schema)"
  ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE ALL ON TABLES FROM PUBLIC;
  -- likewise ON SEQUENCES, and ON FUNCTIONS (IN SCHEMA public only)
  ```

## golang-migrate

`make migrate-up` cannot run 000138's row level security step wherever that
step has work to do. golang-migrate sends the whole file as one multi-statement
query, where every statement after the file's explicit COMMIT runs in an
implicit transaction block, so the step's first per-table COMMIT fails with
`invalid_transaction_termination` and `schema_migrations` is left dirty at 138
(the privileges have committed by then; no table has changed). That needs a
server with the `anon` and `authenticated` roles and a table with row level
security off. No environment has both today: prod is applied by hand with psql,
and local docker and the test containers have no such roles, so there the file
is a no-op. On such a server, apply the file with `psql -X -v ON_ERROR_STOP=1 -f`
and then run `migrate ... force 138`.

## Who else notices

- `supabase_read_only_user` (the dashboard's read-only SQL, Management API
  read-only queries, Supabase MCP in read-only mode) could execute our
  functions only through `PUBLIC`, so it can no longer call them. It still
  reads every table. Grant EXECUTE on a specific function to it if a read-only
  caller needs one.
- The schema-less default covers every function `postgres` creates from now
  on in any schema: each is born executable by `postgres` alone, plus that
  schema's own default privileges. A future Auth hook, or a helper that a
  storage or realtime policy calls, needs an explicit `GRANT EXECUTE` to the
  role that calls it.
- `web/scripts/test-db-setup.ts` (`npm run test:seed`, which
  `scripts/run-e2e-tests.sh` runs in CI mode) used the Data API with the anon
  key and defaulted to prod's URL, and it DELETEs the `stock_prices` and
  `shorts` rows of five codes before inserting fake ones. It never got that far
  (its CommonJS entry check threw in an ES module), and 000138 now denies it.
  It is guarded: it refuses to run unless `SUPABASE_URL` is set and is not the
  prod project (`web/scripts/test-db-target.mjs`), so point it at a local or
  test project.

## Still open outside public: switch the Data API off

Supabase owns the other schemas, and `postgres` cannot revoke what `anon` holds
there. Measured 2026-10-21: EXECUTE on 8 SECURITY DEFINER functions in
`pgsodium` (among them `create_key`, which runs as `pgsodium_keymaker`), SELECT
on `realtime.subscription` (row level security off) and SELECT on
`extensions.pg_stat_statements`. PostgREST reaches only the schemas the project
exposes, so these are out of reach only while the hosted Data API exposes
nothing but `public` and `graphql_public`. Nothing uses the Data API: switch it
off in the dashboard (**Project Settings > Data API**), or at least confirm
the exposed schemas there. `supabase/config.toml`, which only configures local
development, lists `public`, `storage` and `graphql_public`.

## Keeping it closed

- `services/migrations/data_api_grants.test.mjs` fails when any `.sql` file in
  the repository GRANTs anything to `anon`, `authenticated` or `PUBLIC`, makes
  one of them an owner, creates a policy, or FORCEs or DISABLEs row level
  security; when a GRANT's grantee is computed (a format placeholder) anywhere
  but the two reviewed carries in 000131 and 000132; and when a migration's
  `SECURITY DEFINER` function does not pin `search_path` and revoke `PUBLIC`'s
  EXECUTE.
- Every `.sql` file, not only migrations, because psql or `supabase db push`
  would run any of them: `web/package.json`'s `supabase:migrate` is `supabase
  db push`, which applies the legacy `supabase/` and `web/supabase/` SQL to
  whatever project is linked. That SQL's old grants are commented out.
- The same test pins 000138's catalog queries, its in-flight look and refusal,
  and the check's scope and every class whole, not by fragments. They were
  verified on a prod-like rig as they stand: change one only with a
  re-verification, and change its pin in the same commit.
- A new allowlisted migration goes ABOVE 000138 in `terraform-deploy.yml`, so
  000138 stays the last file a deploy replays.
