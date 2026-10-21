-- prod-data-api-check.sql: is the Supabase Data API closed on schema public?
--
-- The posture services/migrations/000138_harden_data_api_grants.up.sql puts in
-- place. ONE ROW PER VIOLATION, ZERO ROWS WHEN CLOSED. Read-only, plain SQL:
-- no psql meta-command and no transaction control, so prod-psql.sh's probe
-- mode accepts it and runs it inside BEGIN READ ONLY ... ROLLBACK:
--
--   task db:prod:psql -- -P pager=off -f scripts/prod-data-api-check.sql
--
-- Checked in schema public:
--   rls_disabled                  an ordinary or partitioned table with row level security off
--   rls_forced                    FORCE ROW LEVEL SECURITY on (000138 never sets it)
--   policy_for_api_role           a policy that applies to PUBLIC, anon or authenticated
--   relation_privilege            anon or authenticated holds a privilege on a table, view,
--                                 materialized view or foreign table, on the whole relation
--                                 or on any column of it
--   sequence_privilege            anon or authenticated holds USAGE, SELECT or UPDATE on a sequence
--   function_execute              PUBLIC, anon or authenticated can EXECUTE a function,
--                                 procedure or aggregate
--   extension_relation_privilege  anon or authenticated holds a privilege on a table, view,
--                                 materialized view, foreign table or sequence that belongs
--                                 to an extension
--   default_acl                   postgres's default privileges in public grant tables,
--                                 sequences or functions to anon or authenticated
--   default_acl_global            postgres's schema-less default privileges, which apply in
--                                 every schema, grant tables, sequences or functions to anon
--                                 or authenticated
--   default_acl_public_execute    postgres's schema-less default lets PUBLIC execute every
--                                 new function
-- Extension members are the migration's one exclusion: an extension's objects
-- belong to whoever installed it (supabase_admin, on Supabase), and ALTER
-- EXTENSION UPDATE would restore their grants. Their functions are left out
-- here as well: pg_trgm and vector, the two extensions in public, compute over
-- their arguments and read no table. Their relations are not. An extension
-- installed into public brings its tables and views in with supabase_admin's
-- default privileges there, which grant anon and authenticated everything, so
-- one anon or authenticated can use is reported as extension_relation_privilege.
-- 000138 cannot close that row (it never touches extension members, and
-- postgres does not own them): it needs a superuser, or the extension moved out
-- of public. Every other class is one the migration closes, except where
-- postgres cannot act for an object's owner; the migration names those objects
-- in a NOTICE and leaves them for their owner.
-- Not checked: supabase_admin's own default privileges in public (only
-- supabase_admin or a superuser can change them, and whatever it creates there
-- shows up above, as relation_privilege, function_execute or
-- extension_relation_privilege), schemas other than public, and service_role,
-- whose key is a server-side secret by design.
--
-- Roles are looked up in pg_roles, never cast from a name. A server without
-- them (local docker, test containers) has no Data API, so there the check
-- returns zero rows rather than an error: the final SELECT reports nothing
-- unless anon or authenticated exists, which also keeps the classes that are
-- not about those roles (rls_disabled, PUBLIC's EXECUTE) quiet there.

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
ext_rel AS (
    SELECT c.oid, c.relname, c.relkind, c.relrowsecurity, e.extname
      FROM pg_class c
      JOIN pg_depend d ON d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'
                      AND d.refclassid = 'pg_extension'::regclass
      JOIN pg_extension e ON e.oid = d.refobjid
     WHERE c.relnamespace = 'public'::regnamespace
       AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
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
    SELECT 'extension_relation_privilege',
           format('public.%I', ext_rel.relname),
           format('%s holds %s on this %s of extension %s%s, which 000138 does not touch', api.rolname, held.list,
                  CASE ext_rel.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view'
                                       WHEN 'f' THEN 'foreign table' WHEN 'S' THEN 'sequence' ELSE 'table' END,
                  ext_rel.extname,
                  CASE WHEN ext_rel.relkind IN ('r', 'p') AND NOT ext_rel.relrowsecurity
                       THEN ' (row level security off)' ELSE '' END)
      FROM ext_rel
     CROSS JOIN api
     CROSS JOIN LATERAL (
            SELECT string_agg(p.priv, ',' ORDER BY p.priv) AS list
              FROM unnest(CASE WHEN ext_rel.relkind = 'S' THEN ARRAY['USAGE', 'SELECT', 'UPDATE']
                               ELSE ARRAY(SELECT privs.priv FROM privs) END) AS p(priv)
             WHERE CASE WHEN ext_rel.relkind = 'S'
                        THEN has_sequence_privilege(api.oid, ext_rel.oid, p.priv)
                        WHEN p.priv IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
                        THEN has_any_column_privilege(api.oid, ext_rel.oid, p.priv)
                        ELSE has_table_privilege(api.oid, ext_rel.oid, p.priv) END
          ) held
     WHERE held.list IS NOT NULL

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
    SELECT 'default_acl_global',
           format('FOR ROLE postgres ON %s (every schema)',
                  CASE d.defaclobjtype WHEN 'r' THEN 'TABLES' WHEN 'S' THEN 'SEQUENCES' ELSE 'FUNCTIONS' END),
           format('new objects in every schema are granted to %s',
                  (SELECT string_agg(api.rolname, ', ' ORDER BY api.rolname)
                     FROM api
                    WHERE api.oid IN (SELECT a.grantee FROM aclexplode(d.defaclacl) a)))
      FROM pg_default_acl d
     WHERE d.defaclrole = (SELECT oid FROM pg)
       AND d.defaclnamespace = 0
       AND d.defaclobjtype IN ('r', 'S', 'f')
       AND EXISTS (SELECT 1 FROM aclexplode(d.defaclacl) a WHERE a.grantee IN (SELECT oid FROM api))

    UNION ALL
    SELECT 'default_acl_public_execute',
           'FOR ROLE postgres ON FUNCTIONS (every schema)',
           'every new function postgres creates is executable by PUBLIC'
      FROM pg
     WHERE EXISTS (SELECT 1
                     FROM aclexplode(coalesce(
                            (SELECT d.defaclacl FROM pg_default_acl d
                              WHERE d.defaclrole = pg.oid AND d.defaclnamespace = 0 AND d.defaclobjtype = 'f'),
                            acldefault('f', pg.oid))) a
                    WHERE a.grantee = 0)
)
SELECT violation, object, detail
  FROM violations
 WHERE EXISTS (SELECT 1 FROM api)
 ORDER BY violation, object, detail;
