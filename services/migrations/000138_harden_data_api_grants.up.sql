-- Migration 000138: close the Supabase Data API (PostgREST) on schema public
--
-- WHY. Prod is a Supabase project, so PostgREST runs beside the API (it
-- connects as role authenticator and switches to anon, authenticated or
-- service_role per request) and serves schema public to anyone holding the
-- project's anon key, which Supabase does not treat as a secret. Nothing here
-- uses it: the Go services and jobs connect as postgres, which owns every
-- object in public and has BYPASSRLS, and pg_stat_statements (reset
-- 2026-07-23) holds zero statements by anon, authenticated or service_role;
-- authenticator ran only PostgREST's schema-cache introspection. Measured
-- read-only on 2026-10-21, Supabase's default privileges had nonetheless given
-- anon and authenticated every privilege (SELECT, INSERT, UPDATE, DELETE,
-- TRUNCATE, REFERENCES, TRIGGER) on all 154 relations in public, including 24
-- materialized views and 18 views, three of them auto-updatable, which run as
-- their owner postgres and so would write through to their base tables;
-- USAGE, SELECT and UPDATE on all 17 sequences; and EXECUTE, through PUBLIC
-- as well, on all 23 of our functions (the MV refreshes,
-- reset_stuck_enrichment_jobs, and the SECURITY DEFINER event-trigger
-- function rls_auto_enable). 16 tables, shorts and stock_prices among them,
-- had row level security off. The other 96 had it on with no policy, which
-- denies everything, but only on tables: RLS does nothing for a view or a
-- materialized view. No anon key was found in the public repo's history or in
-- the shipped JavaScript, so the exposure was latent, not observed. This file
-- removes it in the database instead of relying on the key staying unknown.
--
-- WHAT IT DOES, in schema public, on a server that has the PostgREST roles:
--   1. revokes everything PUBLIC, anon and authenticated hold on every table,
--      partitioned table, view, materialized view, foreign table and sequence
--      (a table-level REVOKE also revokes the same privileges on each column),
--      and EXECUTE on every function, procedure and aggregate;
--   2. stops postgres's default privileges in public from granting new tables,
--      sequences and functions to anon and authenticated, and stops its global
--      default from granting EXECUTE on new functions to PUBLIC. That one has to
--      be schema-less: a per-schema default can only add to the built-in
--      default (EXECUTE to PUBLIC), never take it away;
--   3. enables row level security on every table, as defence in depth: with no
--      policy, a table then denies every role that is neither its owner nor
--      BYPASSRLS, even if a grant comes back.
-- The backend sees no change from any of it. It owns everything, and an owner
-- keeps its own privileges whatever is revoked from others; RLS without FORCE
-- never applies to an owner; and postgres has BYPASSRLS anyway. Triggers keep
-- firing (a trigger does not check EXECUTE on its function) and so does the
-- ensure_rls event trigger.
--
-- WHO ELSE NOTICES:
--   * supabase_read_only_user (the dashboard's read-only SQL, read-only queries
--     through the Management API, Supabase MCP in read-only mode) could EXECUTE
--     our functions only through PUBLIC, so it can no longer call them. It
--     still reads every table through pg_read_all_data. If a read-only caller
--     needs a function, grant EXECUTE on that function to that role explicitly.
--   * The schema-less default (item 2 above) covers every function postgres
--     creates from now on in ANY schema, not only public: each is born
--     executable by postgres alone, plus whatever that schema's own default
--     privileges grant.
--     A future Auth hook, or a helper that a storage or realtime policy calls,
--     needs an explicit GRANT EXECUTE to the role that calls it.
--
-- WHAT IT DOES NOT DO, deliberately:
--   * FORCE ROW LEVEL SECURITY. FORCE is the one switch that would subject an
--     owner to RLS. postgres's BYPASSRLS would still override it, but a table
--     or view owned by any other role would read as empty with no policy.
--   * Schema privileges. anon keeps USAGE on public (PUBLIC has it too and the
--     backend resolves names through it). USAGE without any object privilege
--     exposes nothing, and anon has no CREATE there.
--   * Extension members. pg_trgm and vector live in public, owned by
--     supabase_admin. Their functions stay callable: they compute over their
--     arguments and read no table, and ALTER EXTENSION UPDATE would restore
--     their grants anyway.
--   * The ensure_rls event trigger and its function public.rls_auto_enable().
--     Supabase manages both (a dashboard setting). They enable RLS on each new
--     table in prod, but no file in this repo creates them, which is why
--     tables older than the trigger had RLS off, and nothing here depends on
--     them. rls_auto_enable is a SECURITY DEFINER function in public, so step 1
--     revokes its EXECUTE like any other function's; an event trigger does not
--     check EXECUTE when it fires, so the trigger keeps working.
--   * supabase_admin's default privileges in public, which also grant to anon
--     and authenticated. Only supabase_admin or a superuser can change them,
--     and prod runs this as postgres, so they are reported with a NOTICE and
--     left alone. What supabase_admin creates in public today is extension
--     members.
--   * service_role. Its key is a server-side secret by design; it keeps its
--     grants and its BYPASSRLS.
--   * Anything outside public. Supabase owns the other schemas, and postgres
--     cannot revoke what anon still holds there (measured 2026-10-21): EXECUTE
--     on 8 SECURITY DEFINER functions in pgsodium (create_key among them, which
--     runs as pgsodium_keymaker), SELECT on realtime.subscription (row level
--     security off) and SELECT on extensions.pg_stat_statements. PostgREST
--     reaches only the schemas the project exposes, so these stay out of reach
--     only while the hosted Data API exposes no schema but public and
--     graphql_public. Nothing uses the Data API, so the owner should switch it
--     off in the dashboard (Project Settings > Data API), or at least confirm
--     the exposed schemas there. supabase/config.toml, which only configures
--     local development, lists public, storage and graphql_public.
--
-- SHAPE. One transaction for the privileges, then one per table for row level
-- security.
--   1. Privileges: BEGIN, SET LOCAL lock_timeout = '3s', one DO block, COMMIT.
--      The block reads the catalog first and lists every REVOKE and ALTER
--      DEFAULT PRIVILEGES still needed. With none (a closed database) it stops
--      there, having written nothing and waited for nothing. A REVOKE takes no
--      lock on its object, so readers and writers of the tables never hold it
--      up. It does rewrite the object's catalog row (pg_class, pg_proc), so it
--      waits for any transaction that has rewritten the same row and not yet
--      committed: a REFRESH MATERIALIZED VIEW (CONCURRENTLY too, which also
--      rewrites the view's pg_class row), a TRUNCATE or an ALTER, for as long
--      as that transaction lasts. Each refresh function refreshes all its views
--      in one transaction, so while one runs it holds every view it has
--      refreshed so far. Each of those statements holds SHARE ROW EXCLUSIVE,
--      EXCLUSIVE or ACCESS EXCLUSIVE on its relation until it commits, modes
--      that readers (ACCESS SHARE), writers (ROW EXCLUSIVE), ANALYZE and
--      CREATE INDEX never take; VACUUM takes ACCESS EXCLUSIVE only for a moment,
--      to truncate a table's empty tail, rewriting no catalog row in a
--      transaction, and an autovacuum worker doing that is not counted. So,
--      before the first REVOKE, the block looks in pg_locks for another backend
--      holding one of those modes on a relation in public and, if it finds one,
--      raises object_in_use naming the backend, its query and the relations:
--      nothing has changed, and psql stops before step 2. Re-run when it has
--      finished. lock_timeout is the backstop for what that look cannot see (a
--      refresh that starts just after it, a concurrent GRANT or CREATE OR
--      REPLACE FUNCTION): the waiting REVOKE is cancelled after 3s and the whole
--      step rolls back. Either way nothing is half-applied.
--   2. Row level security: one DO block that COMMITs after each table.
--      ALTER TABLE ... ENABLE ROW LEVEL SECURITY takes an ACCESS EXCLUSIVE lock.
--      It only flips a catalog flag, so it is instant once granted, but it
--      queues behind any open transaction that has the table locked at all (a
--      refresh reading it, a long report query, a pg_dump), and every new
--      reader of that table queues behind it. Each table's transaction sets its
--      own lock_timeout = '3s' (set_config(..., true)), so that queue lasts 3s
--      at most, and its lock is released at that table's COMMIT, before the
--      next table is asked for. Only the table being waited on holds up its
--      readers, and no lock cycle can form across tables. (In one transaction,
--      every table already flipped stayed locked through each later wait:
--      readers of company-metadata stalled 2.5s behind a busy shorts, and a
--      read locking shorts and then company-metadata deadlocked with the loop.)
--      A table whose lock is not granted in time, or whose wait is chosen to
--      break a deadlock, is skipped with a WARNING naming it: lock_not_available
--      and deadlock_detected are caught per table, in its own subtransaction,
--      and nothing else is. Re-run the file to finish it; its privileges are
--      closed by then. Tables are taken in name order, for a stable log: the
--      order no longer decides how long any lock is held.
--
-- HOW IT RUNS. SET LOCAL inside BEGIN ... COMMIT keeps step 1's lock_timeout
-- to step 1, exactly as in 000132, and set_config(..., true) keeps each table's
-- to that table's transaction; neither reaches a later file, on a direct
-- connection or either pooler. A bare SET would outlive the file. `task
-- db:prod:apply` runs the file through prod-psql.sh, whose classifier reads a
-- COMMIT before the end as `session`: it sets a session statement_timeout = 0,
-- runs the file statement by statement and RESET ALLs before it exits. The
-- deploy replays it with plain `psql -f`, which also sends each statement on
-- its own. Either way step 2's DO runs outside any transaction block, which a
-- DO must do to COMMIT.
-- golang-migrate (`make migrate-up`) cannot run step 2 wherever it has work to
-- do. It sends the whole file as ONE multi-statement query, and every
-- statement after the explicit COMMIT then runs in an implicit transaction
-- block, so the DO's first COMMIT fails with invalid_transaction_termination:
-- step 1 has committed by then, no table has changed, and schema_migrations is
-- left dirty at 138. The DO reaches a COMMIT only on a server that has the anon
-- and authenticated roles and a table with row level security off that
-- current_user can alter. No environment does that today: prod is applied by
-- hand with psql, and local docker and the test containers have no such roles,
-- so there the DO returns before any COMMIT and golang-migrate runs the file as
-- a no-op. On such a server, apply the file with `psql -v ON_ERROR_STOP=1 -f`
-- and then run `migrate ... force 138`.
--
-- REPLAY-SAFE. Every step is catalog-guarded: an object is touched only while
-- its ACL (or a column's) still grants PUBLIC, anon or authenticated something,
-- a default-privilege entry only while it still grants them, a table only while
-- its RLS is off. On a closed database a replay reads the catalog and writes
-- nothing: no catalog row is updated, no lock is taken, PostgREST is not told
-- to reload its schema cache. The file is in the deploy allowlist as the LAST
-- file, after 000132, so a deploy re-closes anything a replayed or hand-applied
-- migration opened again. That happens only while the Deploy Infrastructure
-- workflow runs, and it has been disabled since October 2026. Until it is
-- enabled again, nothing re-closes a re-grant or finishes a deferred table on
-- its own: re-run this file by hand until scripts/prod-data-api-check.sql
-- returns zero rows.
--
-- WHERE THE ROLES DO NOT EXIST. Local docker (role admin) and test containers
-- (test_user, or a superuser called postgres) have no anon or authenticated
-- role and no Data API. There both DO blocks stop at their first check and the
-- file changes nothing. No statement outside a DO block names a role, and
-- inside them every role-dependent statement is EXECUTEd only after pg_roles
-- shows the role exists (and, for postgres's default privileges, after
-- pg_has_role shows current_user can act for it).
--
-- APPLY BY HAND, outside every materialized-view refresh; each holds its
-- views until it ends:
--   refresh_all_materialized_views()            the ASIC sync, from 10:00 UTC (mean 191s, up to 7 min)
--   refresh_housing_materialized_views()        about 11 times a day, at no fixed time (mean 21s)
--   refresh_strategy_views()                    shorted picks, 13:30 UTC on weekdays, and at the end
--                                               of the nightly run that starts at 15:00 UTC
--   refresh_register_materialized_views()       at the end of `shorted influence -mode register-resolve`
--   refresh_aec_donations_materialized_views()  at the end of `shorted influence -mode aec-donations`
-- The housing refresh keeps no schedule, so check right before applying. This
-- read-only query is scripts/prod-data-api-precheck.sql; it returns one row per
-- backend the apply would wait for, and zero rows when it is clear to go:
--   task db:prod:psql -- -P pager=off -f scripts/prod-data-api-precheck.sql
--
--   WITH held AS (
--       SELECT l.pid,
--              string_agg(DISTINCT c.relname::text, ', ' ORDER BY c.relname::text)
--                  FILTER (WHERE l.mode IN ('ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
--                            AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')) AS exclusive_on,
--              string_agg(DISTINCT c.relname::text, ', ' ORDER BY c.relname::text)
--                  FILTER (WHERE c.relkind IN ('r', 'p') AND NOT c.relrowsecurity) AS rls_off
--         FROM pg_locks l
--         JOIN pg_class c ON c.oid = l.relation
--        WHERE l.locktype = 'relation'
--          AND l.granted
--          AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
--          AND c.relnamespace = 'public'::regnamespace
--        GROUP BY l.pid
--   ),
--   backends AS (
--       SELECT a.pid, a.usename, a.application_name, a.state,
--              date_trunc('second', now() - a.xact_start) AS xact_age,
--              concat_ws(', ',
--                  CASE WHEN a.state = 'active'
--                        AND a.query ~* 'refresh_[a-z_]+_views[[:space:]]*[(]|REFRESH[[:space:]]+MATERIALIZED[[:space:]]+VIEW'
--                       THEN 'refresh' END,
--                  CASE WHEN h.exclusive_on IS NOT NULL THEN 'catalog_writer' END,
--                  CASE WHEN h.rls_off IS NOT NULL AND a.xact_start < now() - interval '3 seconds'
--                       THEN 'rls_wait' END) AS why,
--              coalesce(h.exclusive_on, h.rls_off) AS public_relations,
--              left(regexp_replace(a.query, '[[:space:]]+', ' ', 'g'), 80) AS query
--         FROM pg_stat_activity a
--         LEFT JOIN held h ON h.pid = a.pid
--        WHERE a.pid <> pg_backend_pid()
--          AND a.datname = current_database()
--          AND a.backend_type IS DISTINCT FROM 'autovacuum worker'
--   )
--   SELECT pid, usename, application_name, state, xact_age, why, public_relations, query
--     FROM backends
--    WHERE why <> ''
--    ORDER BY xact_age DESC NULLS LAST, pid;
--
-- Then apply it, and check it (zero rows = closed):
--   task db:prod:apply FILE=services/migrations/000138_harden_data_api_grants.up.sql CONFIRM=prod
--   task db:prod:psql -- -P pager=off -f scripts/prod-data-api-check.sql
-- Repeat all three until the check returns zero rows: a refresh that started
-- in between stops step 1 with an error, and a busy table is deferred with a
-- WARNING. A row the file cannot close (an object postgres cannot act for,
-- which the file names in a NOTICE) needs its owner or a superuser. The
-- runbook is docs/operations/supabase-data-api.md. The down migration is a
-- deliberate no-op; see it for why.

-- ===========================================================================
-- Step 1, one transaction: privileges (no lock on any table)
-- ===========================================================================
BEGIN;

SET LOCAL lock_timeout = '3s';

DO $m138$
DECLARE
    public_oid  oid := (SELECT oid FROM pg_namespace WHERE nspname = 'public');
    pg_oid      oid := (SELECT oid FROM pg_roles WHERE rolname = 'postgres');
    api_oids    oid[];
    api_roles   text;   -- the PostgREST roles that exist here, quoted: anon, authenticated
    from_list   text;   -- PUBLIC, anon, authenticated
    r           record;
    todo        text[] := '{}';  -- every REVOKE and ALTER DEFAULT PRIVILEGES still needed, in order
    stmt        text;
    in_flight   text;
    n_relations int := 0;
    n_routines  int := 0;
    n_defaults  int := 0;
    left_alone  text[] := '{}';
BEGIN
    SELECT array_agg(oid ORDER BY rolname), string_agg(format('%I', rolname), ', ' ORDER BY rolname)
      INTO api_oids, api_roles
      FROM pg_roles
     WHERE rolname IN ('anon', 'authenticated');

    IF api_oids IS NULL OR public_oid IS NULL THEN
        RAISE NOTICE '000138: no anon or authenticated role on this server (no Data API), nothing to close';
        RETURN;
    END IF;
    from_list := 'PUBLIC, ' || api_roles;

    -- 1a. Relations. A NULL relacl is the built-in default (owner only), so
    --     only an explicit entry for PUBLIC, anon or authenticated, on the
    --     relation or on one of its columns, needs revoking.
    FOR r IN
        SELECT n.nspname, c.relname, c.relkind, c.relowner
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relnamespace = public_oid
           AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
           AND NOT EXISTS (SELECT 1 FROM pg_depend d
                            WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
           AND (EXISTS (SELECT 1 FROM aclexplode(c.relacl) a
                         WHERE a.grantee = 0 OR a.grantee = ANY (api_oids))
                OR EXISTS (SELECT 1 FROM pg_attribute att
                             CROSS JOIN LATERAL aclexplode(att.attacl) a
                            WHERE att.attrelid = c.oid AND att.attacl IS NOT NULL
                              AND (a.grantee = 0 OR a.grantee = ANY (api_oids))))
         ORDER BY c.relname
    LOOP
        IF NOT pg_has_role(current_user, r.relowner, 'MEMBER') THEN
            left_alone := left_alone || format('%I.%I (owner %I)', r.nspname, r.relname, pg_get_userbyid(r.relowner));
            CONTINUE;
        END IF;
        todo := todo || format('REVOKE ALL ON %s %I.%I FROM %s CASCADE',
                               CASE r.relkind WHEN 'S' THEN 'SEQUENCE' ELSE 'TABLE' END,
                               r.nspname, r.relname, from_list);
        n_relations := n_relations + 1;
    END LOOP;

    -- 1b. Functions, procedures and aggregates (ROUTINE names all three). A
    --     NULL proacl is the built-in default, which is EXECUTE to PUBLIC.
    FOR r IN
        SELECT n.nspname, p.proname, p.proowner, oidvectortypes(p.proargtypes) AS args
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE p.pronamespace = public_oid
           AND NOT EXISTS (SELECT 1 FROM pg_depend d
                            WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
           AND EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                        WHERE a.grantee = 0 OR a.grantee = ANY (api_oids))
         ORDER BY p.proname, 4
    LOOP
        IF NOT pg_has_role(current_user, r.proowner, 'MEMBER') THEN
            left_alone := left_alone || format('%I.%I(%s) (owner %I)', r.nspname, r.proname, r.args, pg_get_userbyid(r.proowner));
            CONTINUE;
        END IF;
        todo := todo || format('REVOKE ALL ON ROUTINE %I.%I(%s) FROM %s CASCADE',
                               r.nspname, r.proname, r.args, from_list);
        n_routines := n_routines + 1;
    END LOOP;

    -- 2. postgres's default privileges: what every object it creates from now
    --    on is born with. Checked in two steps so pg_has_role never sees a
    --    role name that does not exist.
    IF pg_oid IS NULL THEN
        RAISE NOTICE '000138: no postgres role here, so no postgres default privileges to close';
    ELSIF NOT pg_has_role(current_user, 'postgres', 'MEMBER') THEN
        RAISE NOTICE '000138: % cannot act for postgres, so its default privileges are left as they are', current_user;
    ELSE
        FOR r IN
            SELECT d.defaclobjtype
              FROM pg_default_acl d
             WHERE d.defaclrole = pg_oid
               AND d.defaclnamespace = public_oid
               AND d.defaclobjtype IN ('r', 'S', 'f')
               AND EXISTS (SELECT 1 FROM aclexplode(d.defaclacl) a WHERE a.grantee = ANY (api_oids))
             ORDER BY 1
        LOOP
            todo := todo || format('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON %s FROM %s',
                                   CASE r.defaclobjtype WHEN 'r' THEN 'TABLES' WHEN 'S' THEN 'SEQUENCES' ELSE 'FUNCTIONS' END,
                                   api_roles);
            n_defaults := n_defaults + 1;
        END LOOP;

        -- With no schema-less entry for postgres, new functions get the
        -- built-in default, EXECUTE to PUBLIC, whatever the per-schema entry says.
        IF EXISTS (SELECT 1
                     FROM aclexplode(coalesce(
                            (SELECT d.defaclacl FROM pg_default_acl d
                              WHERE d.defaclrole = pg_oid AND d.defaclnamespace = 0 AND d.defaclobjtype = 'f'),
                            acldefault('f', pg_oid))) a
                    WHERE a.grantee = 0) THEN
            todo := todo || 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC'::text;
            n_defaults := n_defaults + 1;
        END IF;
    END IF;

    -- Another role's default privileges in public (on Supabase: supabase_admin)
    -- can only be changed by that role or a superuser. Report, never touch.
    FOR r IN
        SELECT pg_get_userbyid(d.defaclrole) AS for_role,
               string_agg(CASE d.defaclobjtype WHEN 'r' THEN 'tables' WHEN 'S' THEN 'sequences' ELSE 'functions' END,
                          ', ' ORDER BY d.defaclobjtype) AS kinds
          FROM pg_default_acl d
         WHERE d.defaclnamespace = public_oid
           AND d.defaclrole IS DISTINCT FROM pg_oid
           AND d.defaclobjtype IN ('r', 'S', 'f')
           AND EXISTS (SELECT 1 FROM aclexplode(d.defaclacl) a WHERE a.grantee = ANY (api_oids))
         GROUP BY d.defaclrole
         ORDER BY 1
    LOOP
        left_alone := left_alone || format('default privileges FOR ROLE %I IN SCHEMA public (%s)', r.for_role, r.kinds);
    END LOOP;

    -- 3. Run the list. An empty list (a closed database) writes and waits for
    --    nothing, so it needs no look at what else is running.
    IF cardinality(todo) > 0 THEN
        -- A REFRESH (CONCURRENTLY too), TRUNCATE or ALTER in flight has
        -- rewritten its relation's catalog row and holds SHARE ROW EXCLUSIVE,
        -- EXCLUSIVE or ACCESS EXCLUSIVE until it commits; a REVOKE of that
        -- relation would wait for it. Refuse at once, with nothing changed,
        -- rather than wait out lock_timeout. An autovacuum worker's brief ACCESS
        -- EXCLUSIVE (truncating a table's empty tail) rewrites no catalog row in
        -- a transaction, so it is not counted.
        SELECT string_agg(format('pid %s (%s) holds %s on %s', h.pid, h.what, h.modes, h.relations), '; ' ORDER BY h.pid)
          INTO in_flight
          FROM (SELECT l.pid,
                       coalesce(left(regexp_replace(a.query, '[[:space:]]+', ' ', 'g'), 80), 'a prepared transaction') AS what,
                       string_agg(DISTINCT l.mode, '/') AS modes,
                       string_agg(DISTINCT c.relname::text, ', ') AS relations
                  FROM pg_locks l
                  JOIN pg_class c ON c.oid = l.relation
                  LEFT JOIN pg_stat_activity a ON a.pid = l.pid
                 WHERE l.locktype = 'relation'
                   AND l.granted
                   AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
                   AND l.mode IN ('ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
                   AND l.pid IS DISTINCT FROM pg_backend_pid()
                   AND a.backend_type IS DISTINCT FROM 'autovacuum worker'
                   AND c.relnamespace = public_oid
                   AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
                 GROUP BY l.pid, a.query) h;
        IF in_flight IS NOT NULL THEN
            RAISE EXCEPTION USING
                ERRCODE = 'object_in_use',
                MESSAGE = format('000138: a REFRESH, TRUNCATE or ALTER is in flight in schema public, so nothing was changed: %s', in_flight),
                HINT    = 'Re-run this file once it has finished; scripts/prod-data-api-precheck.sql returns zero rows when it is clear.';
        END IF;

        FOREACH stmt IN ARRAY todo LOOP
            EXECUTE stmt;
        END LOOP;
    END IF;

    RAISE NOTICE '000138: revoked PUBLIC/anon/authenticated on % relation(s) and % routine(s); closed % default-privilege entries',
        n_relations, n_routines, n_defaults;
    IF cardinality(left_alone) > 0 THEN
        RAISE NOTICE '000138: left as is (% cannot change them): %', current_user, array_to_string(left_alone, '; ');
    END IF;
END
$m138$;

COMMIT;

-- ===========================================================================
-- Step 2, one transaction per table: row level security (ACCESS EXCLUSIVE, 3s each)
-- ===========================================================================
DO $m138$
DECLARE
    t         record;
    enabled   int := 0;
    deferred  text[] := '{}';
    not_owned text[] := '{}';
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('anon', 'authenticated')) THEN
        RAISE NOTICE '000138: no anon or authenticated role on this server (no Data API), row level security left as it is';
        RETURN;
    END IF;

    FOR t IN
        SELECT n.nspname, c.relname, c.relowner
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relkind IN ('r', 'p')
           AND NOT c.relrowsecurity
           AND NOT EXISTS (SELECT 1 FROM pg_depend d
                            WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
         ORDER BY c.relname
    LOOP
        IF NOT pg_has_role(current_user, t.relowner, 'MEMBER') THEN
            not_owned := not_owned || format('%I.%I (owner %I)', t.nspname, t.relname, pg_get_userbyid(t.relowner));
            CONTINUE;
        END IF;
        PERFORM set_config('lock_timeout', '3s', true);  -- this table's transaction only
        BEGIN
            EXECUTE format('ALTER TABLE IF EXISTS %I.%I ENABLE ROW LEVEL SECURITY', t.nspname, t.relname);
            enabled := enabled + 1;
        EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
            deferred := deferred || format('%I.%I', t.nspname, t.relname);
        END;
        -- Ends this table's transaction, and so releases its lock, before the
        -- next table is asked for. It sits outside the block above because a
        -- transaction cannot end inside a block that has an EXCEPTION clause.
        COMMIT;
    END LOOP;

    RAISE NOTICE '000138: row level security enabled on % table(s)', enabled;
    IF cardinality(not_owned) > 0 THEN
        RAISE NOTICE '000138: row level security left off (% cannot alter them): %', current_user, array_to_string(not_owned, '; ');
    END IF;
    IF cardinality(deferred) > 0 THEN
        RAISE WARNING '000138: row level security NOT enabled on % table(s) whose lock was not granted within lock_timeout, or whose wait was chosen to break a deadlock: %. Their privileges are already closed. Re-run this file in a quiet moment (scripts/prod-data-api-precheck.sql returns zero rows) until scripts/prod-data-api-check.sql returns zero rows.',
            cardinality(deferred), array_to_string(deferred, ', ');
    END IF;
END
$m138$;
