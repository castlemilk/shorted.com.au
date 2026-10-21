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
-- function rls_auto_enable). 16 tables,
-- shorts and stock_prices among them, had row level security off. The other
-- 96 had it on with no policy, which denies everything, but only on tables:
-- RLS does nothing for a view or a materialized view. No anon key was found
-- in the public repo's history or in the shipped JavaScript, so the exposure
-- was latent, not observed. This file removes it in the database instead of
-- relying on the key staying unknown.
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
--
-- SHAPE. Two transactions, each opening with SET LOCAL lock_timeout = '3s':
--   1. Privileges: every REVOKE and ALTER DEFAULT PRIVILEGES. GRANT and REVOKE
--      rewrite the object's catalog row without locking the object, so this
--      commits in well under a second whatever is reading the tables, and the
--      part that closes the Data API lands even if step 2 has to wait.
--   2. Row level security: ALTER TABLE ... ENABLE ROW LEVEL SECURITY takes an
--      ACCESS EXCLUSIVE lock. It only flips a catalog flag, so it is instant
--      once granted, but it queues behind any open reader of the table (a
--      refresh of a view over shorts, a pg_dump), and every new reader queues
--      behind it. lock_timeout bounds that queue at 3s, longer than the API's
--      ordinary queries take. A table whose lock is not granted in time is
--      skipped with a WARNING naming it (lock_not_available is caught per table,
--      in its own subtransaction, and nothing else is), and the next replay or a
--      re-run in a quiet moment finishes it; its privileges are closed by then.
--      Tables are taken smallest first (reltuples), so the hottest, shorts and
--      stock_prices, are locked last and held for the shortest time before
--      COMMIT.
-- SET LOCAL inside an explicit BEGIN ... COMMIT is what makes the timeout hold
-- on every path that runs this file, exactly as in 000132. `task
-- db:prod:apply` runs it through prod-psql.sh, whose classifier reads two
-- BEGIN ... COMMIT pairs as `session` (so the wrapper sets a session
-- statement_timeout = 0 and RESET ALLs before it exits); the deploy replays it
-- with plain `psql -f`; golang-migrate (`make migrate-up`) sends it as one
-- multi-statement query. On all three each BEGIN opens a real transaction, so
-- each SET LOCAL lasts exactly as long as its transaction, on a direct
-- connection or either pooler, and never reaches a later file. A bare SET would
-- outlive the file; a SET LOCAL with no BEGIN around it only warns and does
-- nothing.
--
-- REPLAY-SAFE. Every step is catalog-guarded: an object is touched only while
-- its ACL (or a column's) still grants PUBLIC, anon or authenticated something,
-- a default-privilege entry only while it still grants them, a table only while
-- its RLS is off. On a closed database a replay reads the catalog and writes
-- nothing: no catalog row is updated, no lock is taken, PostgREST is not told
-- to reload its schema cache. The file is in the deploy allowlist as the LAST
-- file, after 000132, so every deploy re-closes anything a replayed or
-- hand-applied migration opened again.
--
-- WHERE THE ROLES DO NOT EXIST. Local docker (role admin) and test containers
-- (test_user, or a superuser called postgres) have no anon or authenticated
-- role and no Data API. There both DO blocks stop at their first check and the
-- file changes nothing. No statement outside a DO block names a role, and
-- inside them every role-dependent statement is EXECUTEd only after pg_roles
-- shows the role exists (and, for postgres's default privileges, after
-- pg_has_role shows current_user can act for it).
--
-- APPLY BY HAND in a quiet window (not 10:00 UTC refresh_all_materialized_views,
-- not 13:30 UTC `shorted picks -mode refresh`, not while the ASIC sync runs):
--   task db:prod:apply FILE=services/migrations/000138_harden_data_api_grants.up.sql CONFIRM=prod
-- then confirm it is closed (zero rows):
--   task db:prod:psql -- -P pager=off -f scripts/prod-data-api-check.sql
-- The down migration is a deliberate no-op; see it for why.

-- ===========================================================================
-- Transaction 1: privileges (no lock on any table)
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
        EXECUTE format('REVOKE ALL ON %s %I.%I FROM %s CASCADE',
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
        EXECUTE format('REVOKE ALL ON ROUTINE %I.%I(%s) FROM %s CASCADE',
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
            EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON %s FROM %s',
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
            EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC';
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

    RAISE NOTICE '000138: revoked PUBLIC/anon/authenticated on % relation(s) and % routine(s); closed % default-privilege entries',
        n_relations, n_routines, n_defaults;
    IF cardinality(left_alone) > 0 THEN
        RAISE NOTICE '000138: left as is (% cannot change them): %', current_user, array_to_string(left_alone, '; ');
    END IF;
END
$m138$;

COMMIT;

-- ===========================================================================
-- Transaction 2: row level security on every table (ACCESS EXCLUSIVE, bounded)
-- ===========================================================================
BEGIN;

SET LOCAL lock_timeout = '3s';

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
         ORDER BY greatest(c.reltuples, 0), c.relname
    LOOP
        IF NOT pg_has_role(current_user, t.relowner, 'MEMBER') THEN
            not_owned := not_owned || format('%I.%I (owner %I)', t.nspname, t.relname, pg_get_userbyid(t.relowner));
            CONTINUE;
        END IF;
        BEGIN
            EXECUTE format('ALTER TABLE IF EXISTS %I.%I ENABLE ROW LEVEL SECURITY', t.nspname, t.relname);
            enabled := enabled + 1;
        EXCEPTION WHEN lock_not_available THEN
            deferred := deferred || format('%I.%I', t.nspname, t.relname);
        END;
    END LOOP;

    RAISE NOTICE '000138: row level security enabled on % table(s)', enabled;
    IF cardinality(not_owned) > 0 THEN
        RAISE NOTICE '000138: row level security left off (% cannot alter them): %', current_user, array_to_string(not_owned, '; ');
    END IF;
    IF cardinality(deferred) > 0 THEN
        RAISE WARNING '000138: row level security NOT enabled on % table(s) whose lock was not granted within lock_timeout: %. Their privileges are already closed; re-run this file in a quiet moment, or let the next deploy replay it.',
            cardinality(deferred), array_to_string(deferred, ', ');
    END IF;
END
$m138$;

COMMIT;
