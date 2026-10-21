-- prod-data-api-check.sql: is the Supabase Data API closed on schema public?
--
-- The posture services/migrations/000138_harden_data_api_grants.up.sql puts in
-- place. ONE ROW PER VIOLATION, ZERO ROWS WHEN CLOSED. Read-only, plain SQL:
-- no psql meta-command and no transaction control, so prod-psql.sh's probe
-- mode accepts it and runs it inside BEGIN READ ONLY ... ROLLBACK:
--
--   task db:prod:psql -- -P pager=off -f scripts/prod-data-api-check.sql
--
-- Checked in schema public, extension members (pg_trgm, vector) excluded, as
-- in the migration:
--   rls_disabled                an ordinary or partitioned table with row level security off
--   rls_forced                  FORCE ROW LEVEL SECURITY on (000138 never sets it)
--   policy_for_api_role         a policy that applies to PUBLIC, anon or authenticated
--   relation_privilege          anon or authenticated holds a privilege on a table, view,
--                               materialized view or foreign table, on the whole relation
--                               or on any column of it
--   sequence_privilege          anon or authenticated holds USAGE, SELECT or UPDATE on a sequence
--   function_execute            PUBLIC, anon or authenticated can EXECUTE a function,
--                               procedure or aggregate
--   default_acl                 postgres's default privileges in public grant tables,
--                               sequences or functions to anon or authenticated
--   default_acl_public_execute  postgres's schema-less default lets PUBLIC execute every
--                               new function
-- Not checked, because the migration runs as postgres and cannot change them:
-- supabase_admin's own default privileges in public (they apply only to what
-- supabase_admin creates, which in public is extension members), schemas other
-- than public, and service_role, whose key is a server-side secret by design.
-- Anything supabase_admin did create in public with grants would still show
-- up here, as relation_privilege or function_execute.
--
-- Roles are looked up in pg_roles, never cast from a name, so on a server
-- without them (local docker, test containers) the role-based checks return
-- nothing rather than an error.

WITH api AS (
    SELECT oid, rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')
),
pg AS (
    SELECT oid FROM pg_roles WHERE rolname = 'postgres'
),
rel AS (
    SELECT c.oid, c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace
       AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
       AND NOT EXISTS (SELECT 1 FROM pg_depend d
                        WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
),
fn AS (
    SELECT p.oid, p.proname, p.proowner, p.proacl, p.prosecdef, oidvectortypes(p.proargtypes) AS args
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND NOT EXISTS (SELECT 1 FROM pg_depend d
                        WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
),
privs AS (
    SELECT unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS priv
),
violations AS (
    SELECT 'rls_disabled' AS violation,
           format('public.%I', rel.relname) AS object,
           'row level security is off' AS detail
      FROM rel
     WHERE rel.relkind IN ('r', 'p') AND NOT rel.relrowsecurity

    UNION ALL
    SELECT 'rls_forced',
           format('public.%I', rel.relname),
           'FORCE ROW LEVEL SECURITY is on, which 000138 never sets'
      FROM rel
     WHERE rel.relkind IN ('r', 'p') AND rel.relforcerowsecurity

    UNION ALL
    SELECT 'policy_for_api_role',
           format('public.%I', c.relname),
           format('policy %I applies to %s', pol.polname,
                  CASE WHEN 0 = ANY (pol.polroles) THEN 'PUBLIC'
                       ELSE (SELECT string_agg(api.rolname, ', ' ORDER BY api.rolname)
                               FROM api WHERE api.oid = ANY (pol.polroles)) END)
      FROM pg_policy pol
      JOIN pg_class c ON c.oid = pol.polrelid
     WHERE c.relnamespace = 'public'::regnamespace
       AND (0 = ANY (pol.polroles) OR pol.polroles && ARRAY(SELECT oid FROM api))

    UNION ALL
    SELECT 'relation_privilege',
           format('public.%I', rel.relname),
           format('%s holds %s on this %s', api.rolname, held.list,
                  CASE rel.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view'
                                   WHEN 'f' THEN 'foreign table' ELSE 'table' END)
      FROM rel
     CROSS JOIN api
     CROSS JOIN LATERAL (
            SELECT string_agg(privs.priv, ',' ORDER BY privs.priv) AS list
              FROM privs
             WHERE CASE WHEN privs.priv IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
                        THEN has_any_column_privilege(api.oid, rel.oid, privs.priv)
                        ELSE has_table_privilege(api.oid, rel.oid, privs.priv) END
          ) held
     WHERE rel.relkind <> 'S' AND held.list IS NOT NULL

    UNION ALL
    SELECT 'sequence_privilege',
           format('public.%I', rel.relname),
           format('%s holds %s on this sequence', api.rolname,
                  concat_ws(',',
                    CASE WHEN has_sequence_privilege(api.oid, rel.oid, 'USAGE') THEN 'USAGE' END,
                    CASE WHEN has_sequence_privilege(api.oid, rel.oid, 'SELECT') THEN 'SELECT' END,
                    CASE WHEN has_sequence_privilege(api.oid, rel.oid, 'UPDATE') THEN 'UPDATE' END))
      FROM rel
     CROSS JOIN api
     WHERE rel.relkind = 'S'
       AND (has_sequence_privilege(api.oid, rel.oid, 'USAGE')
            OR has_sequence_privilege(api.oid, rel.oid, 'SELECT')
            OR has_sequence_privilege(api.oid, rel.oid, 'UPDATE'))

    UNION ALL
    SELECT 'function_execute',
           format('public.%I(%s)', fn.proname, fn.args),
           format('executable by %s%s', who.list,
                  CASE WHEN fn.prosecdef THEN ' (SECURITY DEFINER: runs as its owner)' ELSE '' END)
      FROM fn
     CROSS JOIN LATERAL (
            SELECT string_agg(grantee, ', ' ORDER BY grantee) AS list
              FROM (SELECT 'PUBLIC' AS grantee
                     WHERE EXISTS (SELECT 1 FROM aclexplode(coalesce(fn.proacl, acldefault('f', fn.proowner))) a
                                    WHERE a.grantee = 0)
                    UNION ALL
                    SELECT api.rolname FROM api
                     WHERE has_function_privilege(api.oid, fn.oid, 'EXECUTE')) g
          ) who
     WHERE who.list IS NOT NULL

    UNION ALL
    SELECT 'default_acl',
           format('FOR ROLE postgres IN SCHEMA public ON %s',
                  CASE d.defaclobjtype WHEN 'r' THEN 'TABLES' WHEN 'S' THEN 'SEQUENCES' ELSE 'FUNCTIONS' END),
           format('new objects are granted to %s',
                  (SELECT string_agg(api.rolname, ', ' ORDER BY api.rolname)
                     FROM api
                    WHERE api.oid IN (SELECT a.grantee FROM aclexplode(d.defaclacl) a)))
      FROM pg_default_acl d
     WHERE d.defaclrole = (SELECT oid FROM pg)
       AND d.defaclnamespace = 'public'::regnamespace
       AND d.defaclobjtype IN ('r', 'S', 'f')
       AND EXISTS (SELECT 1 FROM aclexplode(d.defaclacl) a WHERE a.grantee IN (SELECT oid FROM api))

    UNION ALL
    SELECT 'default_acl_public_execute',
           'FOR ROLE postgres ON FUNCTIONS (every schema)',
           'every new function postgres creates is executable by PUBLIC'
      FROM pg
     WHERE EXISTS (SELECT 1 FROM api)
       AND EXISTS (SELECT 1
                     FROM aclexplode(coalesce(
                            (SELECT d.defaclacl FROM pg_default_acl d
                              WHERE d.defaclrole = pg.oid AND d.defaclnamespace = 0 AND d.defaclobjtype = 'f'),
                            acldefault('f', pg.oid))) a
                    WHERE a.grantee = 0)
)
SELECT violation, object, detail
  FROM violations
 ORDER BY violation, object, detail;
