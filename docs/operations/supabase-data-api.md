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

The housing refresh keeps no schedule, so always run the pre-check right
before applying.

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
- **`ERROR: canceling statement due to lock timeout`, `CONTEXT: while updating tuple ... in relation "pg_class"`.**
  The backstop: something the look cannot see (a refresh that started just
  after it, a concurrent GRANT or CREATE OR REPLACE FUNCTION) held a row for
  more than 3s. Step 1 rolled back whole, so again nothing changed. Start
  again from the pre-check.
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
is a no-op. On such a server, apply the file with `psql -v ON_ERROR_STOP=1 -f`
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

- `services/migrations/data_api_grants.test.mjs` fails on a migration that
  GRANTs anything to `anon`, `authenticated` or `PUBLIC`, creates a policy, or
  FORCEs or DISABLEs row level security, and on a `SECURITY DEFINER` function
  that does not pin `search_path` and revoke `PUBLIC`'s EXECUTE.
- The grant scan also covers the legacy Supabase CLI SQL under `supabase/` and
  `web/supabase/`: `web/package.json`'s `supabase:migrate` is `supabase db
  push`, which would apply it to whatever project is linked. Its old grants are
  commented out.
- A new allowlisted migration goes ABOVE 000138 in `terraform-deploy.yml`, so
  000138 stays the last file a deploy replays.
