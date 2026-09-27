-- Widen stock_prices' price columns from DECIMAL(10,2) to NUMERIC(12,4).
--
-- Two decimals stored every sub-cent price as $0.00 and rounded every price
-- under ten cents to the cent: ENL's $0.042 close was stored as 0, BP8's was 0
-- for two years, and 327 codes held at least one $0 close (the historical dry
-- run of 2026-09-27, execution shorted-price-sync-gl7tc). ASX prices tick in
-- $0.001 at the finest; four decimals hold every tick with room for adjusted
-- closes, and round away the float noise Yahoo's values carry (43.45000076).
--
-- A column's type cannot change under a view that reads it, and several views
-- and materialized views read these columns, some through each other. Prod's
-- definitions are not guaranteed to match this repository (prod does not run
-- `migrate up`), so none is restated here. Each dependent view is read from the
-- catalog, dropped deepest first, and recreated from its own definition once
-- the columns are changed, with its indexes, grants, owner and comments, and
-- with data if it had data. Anything that could not be carried over (a
-- trigger or rule on a view, a column-level grant) stops the migration, and
-- the transaction leaves everything as it was.
--
-- A replay on a widened table does nothing.
--
-- Prod does not run migrations: apply by hand, in a quiet hour. The table is
-- rewritten and its dependent views rebuilt under exclusive locks, which holds
-- reads of prices and of those views for the minutes that takes.
--   task db:prod:apply FILE=services/migrations/000131_widen_stock_price_precision.up.sql CONFIRM=prod

BEGIN;
SET LOCAL statement_timeout = 0;
SET LOCAL lock_timeout = '60s';

DO $migration$
DECLARE
  target      constant text   := 'numeric(12,4)';
  target_prec constant int    := 12;
  target_scale constant int   := 4;
  price_cols  constant text[] := ARRAY['open', 'high', 'low', 'close', 'adjusted_close'];
  dep   record;
  item  record;
  kind  text;
  sql   text;
BEGIN
  IF (SELECT numeric_precision = target_prec AND numeric_scale = target_scale
      FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'stock_prices' AND column_name = 'close') THEN
    RAISE NOTICE 'stock_prices already stores prices as %; nothing to do', target;
    RETURN;
  END IF;

  -- Every view and materialized view that reads stock_prices, directly or
  -- through another view, at the depth of its longest path from the table.
  CREATE TEMP TABLE _stock_price_dependents ON COMMIT DROP AS
  WITH RECURSIVE deps(oid, depth) AS (
    SELECT DISTINCT r.ev_class, 1
    FROM pg_depend d
    JOIN pg_rewrite r ON r.oid = d.objid
    WHERE d.classid = 'pg_rewrite'::regclass
      AND d.refclassid = 'pg_class'::regclass
      AND d.refobjid = 'stock_prices'::regclass
      AND r.ev_class <> 'stock_prices'::regclass
    UNION
    SELECT r.ev_class, deps.depth + 1
    FROM deps
    JOIN pg_depend d ON d.refobjid = deps.oid
      AND d.classid = 'pg_rewrite'::regclass
      AND d.refclassid = 'pg_class'::regclass
    JOIN pg_rewrite r ON r.oid = d.objid
    WHERE r.ev_class <> deps.oid
  )
  SELECT c.oid,
         n.nspname,
         c.relname,
         c.relkind,
         max(deps.depth) AS depth,
         pg_get_viewdef(c.oid) AS definition,
         c.relispopulated AS populated,
         pg_get_userbyid(c.relowner) AS owner,
         c.reloptions,
         c.relacl,
         obj_description(c.oid, 'pg_class') AS comment,
         ARRAY(SELECT i.indexdef FROM pg_indexes i
               WHERE i.schemaname = n.nspname AND i.tablename = c.relname) AS indexes,
         ARRAY(SELECT format('COMMENT ON COLUMN %I.%I.%I IS %L', n.nspname, c.relname, a.attname, ds.description)
               FROM pg_description ds
               JOIN pg_attribute a ON a.attrelid = ds.objoid AND a.attnum = ds.objsubid
               WHERE ds.objoid = c.oid AND ds.classoid = 'pg_class'::regclass AND ds.objsubid > 0) AS column_comments
  FROM deps
  JOIN pg_class c ON c.oid = deps.oid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  GROUP BY c.oid, n.nspname, c.relname, c.relkind, c.relispopulated, c.relowner, c.reloptions, c.relacl;

  -- Refuse what dropping would lose.
  FOR dep IN SELECT * FROM _stock_price_dependents LOOP
    IF dep.relkind NOT IN ('v', 'm') THEN
      RAISE EXCEPTION '%.% (relkind %) reads stock_prices and is not a view', dep.nspname, dep.relname, dep.relkind;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = dep.oid AND NOT tgisinternal) THEN
      RAISE EXCEPTION '%.% has a trigger, which recreating it would drop', dep.nspname, dep.relname;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_rewrite WHERE ev_class = dep.oid AND rulename <> '_RETURN') THEN
      RAISE EXCEPTION '%.% has a rule, which recreating it would drop', dep.nspname, dep.relname;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = dep.oid AND attacl IS NOT NULL) THEN
      RAISE EXCEPTION '%.% has a column-level grant, which recreating it would drop', dep.nspname, dep.relname;
    END IF;
  END LOOP;

  FOR dep IN SELECT * FROM _stock_price_dependents ORDER BY depth DESC, relname LOOP
    kind := CASE dep.relkind WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'VIEW' END;
    EXECUTE format('DROP %s %I.%I', kind, dep.nspname, dep.relname);
  END LOOP;

  sql := 'ALTER TABLE stock_prices';
  FOR i IN 1 .. array_length(price_cols, 1) LOOP
    sql := sql || format('%s ALTER COLUMN %I TYPE %s', CASE WHEN i > 1 THEN ',' ELSE '' END, price_cols[i], target);
  END LOOP;
  EXECUTE sql;

  FOR dep IN SELECT * FROM _stock_price_dependents ORDER BY depth, relname LOOP
    kind := CASE dep.relkind WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'VIEW' END;
    sql := format('CREATE %s %I.%I', kind, dep.nspname, dep.relname);
    IF dep.reloptions IS NOT NULL THEN
      sql := sql || format(' WITH (%s)', array_to_string(dep.reloptions, ', '));
    END IF;
    sql := sql || ' AS ' || rtrim(dep.definition, E'; \n');
    IF dep.relkind = 'm' THEN
      sql := sql || CASE WHEN dep.populated THEN ' WITH DATA' ELSE ' WITH NO DATA' END;
    END IF;
    EXECUTE sql;

    FOR item IN SELECT unnest(dep.indexes) AS def LOOP
      EXECUTE item.def;
    END LOOP;

    IF dep.owner <> current_user THEN
      EXECUTE format('ALTER %s %I.%I OWNER TO %I', kind, dep.nspname, dep.relname, dep.owner);
    END IF;

    -- The grants exactly as they were: first undo what default privileges
    -- granted the new view, then grant what the old one had.
    FOR item IN
      SELECT DISTINCT a.grantee FROM pg_class c, aclexplode(c.relacl) a
      WHERE c.oid = format('%I.%I', dep.nspname, dep.relname)::regclass AND a.grantee <> c.relowner
    LOOP
      EXECUTE format('REVOKE ALL ON TABLE %I.%I FROM %s', dep.nspname, dep.relname,
        CASE WHEN item.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(item.grantee)) END);
    END LOOP;
    FOR item IN
      SELECT a.grantee, a.privilege_type, a.is_grantable
      FROM aclexplode(dep.relacl) a
      WHERE a.grantee <> (SELECT oid FROM pg_roles WHERE rolname = dep.owner)
    LOOP
      EXECUTE format('GRANT %s ON TABLE %I.%I TO %s%s', item.privilege_type, dep.nspname, dep.relname,
        CASE WHEN item.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(item.grantee)) END,
        CASE WHEN item.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END LOOP;

    IF dep.comment IS NOT NULL THEN
      EXECUTE format('COMMENT ON %s %I.%I IS %L', kind, dep.nspname, dep.relname, dep.comment);
    END IF;
    FOR item IN SELECT unnest(dep.column_comments) AS def LOOP
      EXECUTE item.def;
    END LOOP;
  END LOOP;

  RAISE NOTICE 'stock_prices now stores prices as %; % dependent views recreated',
    target, (SELECT count(*) FROM _stock_price_dependents);
END
$migration$;

COMMIT;
