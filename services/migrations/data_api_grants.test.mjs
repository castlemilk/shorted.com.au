// node --test services/migrations/data_api_grants.test.mjs
//
// 000138 closes the Supabase Data API (PostgREST) on schema public. Prod is a
// Supabase project, and Supabase's default privileges had given anon and
// authenticated every privilege on every table, view, materialized view and
// sequence there, and EXECUTE (through PUBLIC as well) on every function:
// scripts/prod-data-api-check.sql listed 385 violations on 2026-10-21. The
// backend never needed any of it (it connects as postgres, the owner of every
// object, with BYPASSRLS).
//
// These pin the file's shape (two transactions, a short lock_timeout, every
// role-dependent statement behind a pg_roles check), what it covers, what makes
// a replay a no-op, its place at the END of the deploy allowlist, the
// read-only check file, and three rules over every migration that keep the
// Data API closed afterwards:
//   * no migration GRANTs anything to anon, authenticated or PUBLIC;
//   * none creates a policy, or FORCEs or DISABLEs row level security;
//   * every SECURITY DEFINER function pins search_path and revokes PUBLIC's
//     EXECUTE in the same file.
// The behaviour itself was exercised against Postgres 15 built with prod's
// role model and default privileges plus the whole migration chain: applied
// through prod-psql.sh, then replayed with plain psql (no catalog row
// rewritten), a no-op where the roles do not exist (golang-migrate up, down,
// up), the backend unaffected, anon and authenticated denied on every object
// kind, REVOKE completing while another session held ACCESS EXCLUSIVE, and a
// table under a long reader skipped after 3s and finished on the next run.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { classify, splitStatements } from "../../scripts/prod-psql-classify.mjs";

const migrationsDir = new URL("./", import.meta.url);
const read = (name) => readFileSync(new URL(name, migrationsDir), "utf8");
const UP = "000138_harden_data_api_grants.up.sql";
const DOWN = "000138_harden_data_api_grants.down.sql";
const up = read(UP);
const down = read(DOWN);
const workflow = readFileSync(new URL("../../.github/workflows/terraform-deploy.yml", import.meta.url), "utf8");
const check = readFileSync(new URL("../../scripts/prod-data-api-check.sql", import.meta.url), "utf8");

/** SQL with `--` comments removed, so prose never satisfies or trips an assertion. */
const code = (sql) => sql.replace(/--.*$/gm, "");
const upCode = code(up);

/**
 * Top-level statements, split by the same lexer prod-psql.sh classifies with:
 * comments dropped, every string shown as 's', every dollar-quoted body as
 * $body$, whitespace collapsed.
 */
const topLevel = (sql) => splitStatements(sql).map((s) => s.text.replace(/\s+/g, " ").trim());

/** The two DO bodies of the up migration, in order: [privileges, row level security]. */
const bodies = [...upCode.matchAll(/^DO \$m138\$\n([\s\S]*?)\n\$m138\$;$/gm)].map((m) => m[1]);
const [privileges, rls] = bodies;

const ROLE_GUARD = /FROM pg_roles\s+WHERE rolname IN \('anon', 'authenticated'\)/;

// ---------------------------------------------------------------------------
// shape

test("two transactions, each opening with SET LOCAL lock_timeout, and nothing else at top level", () => {
  assert.deepEqual(topLevel(up), [
    "BEGIN",
    "SET LOCAL lock_timeout = 's'",
    "DO $body$",
    "COMMIT",
    "BEGIN",
    "SET LOCAL lock_timeout = 's'",
    "DO $body$",
    "COMMIT",
  ]);
  assert.equal(bodies.length, 2, "expected the privileges block and the row level security block");
});

test("lock_timeout is short: an ACCESS EXCLUSIVE wait queues every reader of a hot table behind it", () => {
  const timeouts = [...upCode.matchAll(/SET LOCAL lock_timeout = '(\d+)s';/g)].map((m) => Number(m[1]));
  assert.equal(timeouts.length, 2);
  for (const seconds of timeouts) {
    assert.ok(seconds >= 1 && seconds <= 5, `lock_timeout ${seconds}s: keep it between 1s and 5s`);
  }
  // A session-level SET would outlive the file (the deploy runs several files
  // in one psql session); SET LOCAL ends with its transaction on any pooler.
  assert.doesNotMatch(upCode, /^\s*SET (?!LOCAL)/m);
  assert.doesNotMatch(upCode, /statement_timeout/, "the catalog work is quick; the wrapper owns statement_timeout");
});

test("prod-psql.sh reads it as `session`, as it does 000132's two transactions", () => {
  assert.equal(classify(up).verdict, "session");
  assert.equal(classify(down).verdict, "transaction");
});

// ---------------------------------------------------------------------------
// where the roles do not exist (local docker, test containers)

test("no statement outside a DO block names a role", () => {
  for (const stmt of topLevel(up)) {
    assert.doesNotMatch(stmt, /\b(anon|authenticated|postgres|service_role|supabase_admin|PUBLIC)\b/i, stmt);
  }
});

test("both DO blocks stop at their first statement where anon and authenticated do not exist", () => {
  const privilegesExit = privileges.indexOf("IF api_oids IS NULL OR public_oid IS NULL THEN");
  assert.ok(privilegesExit > 0, "privileges block: early exit");
  assert.match(privileges.slice(0, privilegesExit), ROLE_GUARD);
  assert.match(privileges.slice(privilegesExit, privileges.indexOf("END IF;", privilegesExit)), /RETURN;/);
  assert.doesNotMatch(privileges.slice(0, privilegesExit), /\bEXECUTE\b/, "nothing runs before the check");

  const rlsExit = rls.indexOf("IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('anon', 'authenticated')) THEN");
  assert.ok(rlsExit > 0, "row level security block: early exit");
  assert.match(rls.slice(rlsExit, rls.indexOf("END IF;", rlsExit)), /RETURN;/);
  assert.doesNotMatch(rls.slice(0, rlsExit), /\bEXECUTE\b/, "nothing runs before the check");
});

test("postgres's default privileges change only once the role exists and current_user can act for it", () => {
  const exists = privileges.indexOf("IF pg_oid IS NULL THEN");
  const member = privileges.indexOf("ELSIF NOT pg_has_role(current_user, 'postgres', 'MEMBER') THEN");
  const first = privileges.indexOf("ALTER DEFAULT PRIVILEGES");
  assert.ok(exists > 0 && member > exists && first > member, "role check, then membership check, then the ALTERs");
  assert.match(privileges, /pg_oid\s+oid := \(SELECT oid FROM pg_roles WHERE rolname = 'postgres'\);/);
  // Never a cast from a role name, which errors where the role is missing.
  assert.doesNotMatch(upCode, /'(anon|authenticated|postgres|service_role)'::regrole/);
  // Each ALTER DEFAULT PRIVILEGES is a string handed to EXECUTE, so the block
  // compiles and runs on a server without the role.
  const alters = [...privileges.matchAll(/ALTER DEFAULT PRIVILEGES/g)].map((m) => m.index);
  assert.equal(alters.length, 2);
  for (const at of alters) {
    assert.match(privileges.slice(Math.max(0, at - 20), at), /EXECUTE (format\()?'$/, "ALTER DEFAULT PRIVILEGES via EXECUTE");
  }
  // Only postgres's are changed. supabase_admin's (or anyone else's) are
  // reported and left alone: prod runs this as postgres, which cannot act for them.
  for (const m of privileges.matchAll(/ALTER DEFAULT PRIVILEGES FOR ROLE (\w+)/g)) {
    assert.equal(m[1], "postgres");
  }
  assert.match(privileges, /d\.defaclrole IS DISTINCT FROM pg_oid/);
  assert.match(privileges, /left_alone := left_alone \|\| format\('default privileges FOR ROLE %I IN SCHEMA public/);
});

// ---------------------------------------------------------------------------
// what it covers

test("relations: tables, partitioned tables, views, materialized views, foreign tables and sequences", () => {
  assert.match(privileges, /c\.relkind IN \('r', 'p', 'v', 'm', 'f', 'S'\)/);
  assert.match(
    privileges,
    /EXECUTE format\('REVOKE ALL ON %s %I\.%I FROM %s CASCADE',\s+CASE r\.relkind WHEN 'S' THEN 'SEQUENCE' ELSE 'TABLE' END,\s+r\.nspname, r\.relname, from_list\);/,
  );
  // PUBLIC as well as the two roles: anon inherits whatever PUBLIC holds.
  assert.match(privileges, /from_list := 'PUBLIC, ' \|\| api_roles;/);
});

test("routines: every function, procedure and aggregate, PUBLIC included", () => {
  assert.match(privileges, /EXECUTE format\('REVOKE ALL ON ROUTINE %I\.%I\(%s\) FROM %s CASCADE',\s+r\.nspname, r\.proname, r\.args, from_list\);/);
  // The argument list is the input types only, the identity GRANT/REVOKE take.
  assert.match(privileges, /oidvectortypes\(p\.proargtypes\) AS args/);
  assert.doesNotMatch(privileges, /p\.prokind/, "no routine kind is skipped");
});

test("default privileges: tables, sequences and functions per schema, and the schema-less EXECUTE to PUBLIC", () => {
  assert.match(privileges, /d\.defaclobjtype IN \('r', 'S', 'f'\)/);
  assert.match(
    privileges,
    /EXECUTE format\('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON %s FROM %s',\s+CASE r\.defaclobjtype WHEN 'r' THEN 'TABLES' WHEN 'S' THEN 'SEQUENCES' ELSE 'FUNCTIONS' END,\s+api_roles\);/,
  );
  // A per-schema default can only add to the built-in one (EXECUTE to PUBLIC),
  // so closing new functions to PUBLIC takes the schema-less form.
  assert.match(privileges, /EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC';/);
});

test("row level security on every ordinary and partitioned table, never FORCE", () => {
  assert.match(rls, /c\.relkind IN \('r', 'p'\)/);
  assert.match(rls, /EXECUTE format\('ALTER TABLE IF EXISTS %I\.%I ENABLE ROW LEVEL SECURITY', t\.nspname, t\.relname\);/);
  // FORCE is the one switch that subjects an owner to RLS: with no policy, a
  // table or view owned by a role without BYPASSRLS would read as empty.
  for (const sql of [up, down]) {
    assert.doesNotMatch(code(sql), /FORCE\s+ROW\s+LEVEL\s+SECURITY/i);
    assert.doesNotMatch(code(sql), /DISABLE\s+ROW\s+LEVEL\s+SECURITY/i);
  }
});

test("extension members (pg_trgm and vector live in public) are excluded everywhere", () => {
  const relationExclusion = /NOT EXISTS \(SELECT 1 FROM pg_depend d\s+WHERE d\.classid = 'pg_class'::regclass AND d\.objid = c\.oid AND d\.deptype = 'e'\)/g;
  const routineExclusion = /NOT EXISTS \(SELECT 1 FROM pg_depend d\s+WHERE d\.classid = 'pg_proc'::regclass AND d\.objid = p\.oid AND d\.deptype = 'e'\)/g;
  assert.equal([...privileges.matchAll(relationExclusion)].length, 1, "relations");
  assert.equal([...privileges.matchAll(routineExclusion)].length, 1, "routines");
  assert.equal([...rls.matchAll(relationExclusion)].length, 1, "row level security");
});

test("schema privileges are left alone: USAGE flows through PUBLIC, and the backend resolves names through it", () => {
  assert.doesNotMatch(upCode, /ON SCHEMA/i);
});

test("identifiers are quoted with %I: table names here contain hyphens", () => {
  const executes = [...upCode.matchAll(/EXECUTE (format\('[^']*'|'[^']*')/g)].map((m) => m[1]);
  assert.equal(executes.length, 5, "three REVOKE/ALTER DEFAULT PRIVILEGES formats, one constant, one ALTER TABLE");
  for (const stmt of executes) {
    if (!stmt.startsWith("format(")) {
      assert.doesNotMatch(stmt, /%/, "a constant EXECUTE string interpolates nothing");
      continue;
    }
    // ALTER DEFAULT PRIVILEGES interpolates no object name: a fixed keyword
    // (TABLES / SEQUENCES / FUNCTIONS, from a CASE) and the role list, itself
    // built with format('%I'); the "default privileges" test pins both.
    if (/ALTER DEFAULT PRIVILEGES/.test(stmt)) continue;
    assert.match(stmt, /REVOKE ALL ON|ALTER TABLE/, stmt);
    assert.match(stmt, /%I\.%I/, stmt);
  }
  assert.doesNotMatch(upCode, /quote_ident\(|EXECUTE\s+'[^']*'\s*\|\|/, "no hand-built identifiers");
  assert.match(privileges, /string_agg\(format\('%I', rolname\), ', ' ORDER BY rolname\)/);
});

// ---------------------------------------------------------------------------
// replay-safe: prod replays it on every deploy

test("idempotent statements only: nothing is created, dropped, granted or written", () => {
  assert.doesNotMatch(upCode, /\b(CREATE|DROP|INSERT|UPDATE|DELETE|TRUNCATE|GRANT|COMMENT|VACUUM|REINDEX|CLUSTER)\b/i);
  for (const m of upCode.matchAll(/ALTER TABLE[^,']*/g)) {
    assert.equal(m[0], "ALTER TABLE IF EXISTS %I.%I ENABLE ROW LEVEL SECURITY");
  }
});

test("every step is catalog-guarded, so a closed database replays with no catalog write", () => {
  // relations: only while the relation's ACL or a column's grants PUBLIC/anon/authenticated
  assert.match(privileges, /EXISTS \(SELECT 1 FROM aclexplode\(c\.relacl\) a\s+WHERE a\.grantee = 0 OR a\.grantee = ANY \(api_oids\)\)/);
  assert.match(privileges, /CROSS JOIN LATERAL aclexplode\(att\.attacl\) a\s+WHERE att\.attrelid = c\.oid AND att\.attacl IS NOT NULL\s+AND \(a\.grantee = 0 OR a\.grantee = ANY \(api_oids\)\)/);
  // routines: a NULL proacl is the built-in default, EXECUTE to PUBLIC
  assert.match(privileges, /aclexplode\(coalesce\(p\.proacl, acldefault\('f', p\.proowner\)\)\) a\s+WHERE a\.grantee = 0 OR a\.grantee = ANY \(api_oids\)/);
  // default privileges: only while an entry still grants them
  assert.match(privileges, /EXISTS \(SELECT 1 FROM aclexplode\(d\.defaclacl\) a WHERE a\.grantee = ANY \(api_oids\)\)/);
  assert.match(privileges, /WHERE d\.defaclrole = pg_oid AND d\.defaclnamespace = 0 AND d\.defaclobjtype = 'f'\),\s+acldefault\('f', pg_oid\)\)\) a\s+WHERE a\.grantee = 0\)/);
  // tables: only while RLS is off
  assert.match(rls, /AND NOT c\.relrowsecurity/);
});

test("a contended table is skipped with a WARNING, never a failed deploy, and nothing else is swallowed", () => {
  assert.equal([...upCode.matchAll(/\bEXCEPTION\b/g)].length, 1, "one handler in the whole file");
  assert.match(rls, /BEGIN\n\s+EXECUTE format\('ALTER TABLE IF EXISTS %I\.%I ENABLE ROW LEVEL SECURITY'[^\n]*\n[^\n]*\n\s+EXCEPTION WHEN lock_not_available THEN\n\s+deferred := deferred \|\|/);
  assert.doesNotMatch(upCode, /WHEN OTHERS/i, "a real error must fail the step");
  assert.match(rls, /RAISE WARNING '000138: row level security NOT enabled on % table\(s\) whose lock was not granted within lock_timeout: %/);
});

test("the hottest tables (shorts, stock_prices) are locked last, so they are held for the shortest time", () => {
  assert.match(rls, /ORDER BY greatest\(c\.reltuples, 0\), c\.relname/);
});

test("objects current_user cannot act for are reported, not attempted", () => {
  assert.match(privileges, /IF NOT pg_has_role\(current_user, r\.relowner, 'MEMBER'\) THEN/);
  assert.match(privileges, /IF NOT pg_has_role\(current_user, r\.proowner, 'MEMBER'\) THEN/);
  assert.match(rls, /IF NOT pg_has_role\(current_user, t\.relowner, 'MEMBER'\) THEN/);
});

test("the down migration is a deliberate no-op: it never re-opens the Data API", () => {
  assert.equal(code(down).trim(), "SELECT 1;");
  assert.match(down, /deliberately a no-op/);
});

// ---------------------------------------------------------------------------
// the deploy allowlist

function prodMigrationBlock() {
  const step = workflow.indexOf("- name: Run database migrations");
  const start = workflow.indexOf('if [ "$ENVIRONMENT" = "prod" ]; then', step);
  const end = workflow.indexOf("exit 0", start);
  assert.ok(step > 0 && start > step && end > start, "expected the prod block of the migrations step");
  return workflow.slice(start, end);
}

test("000138 is replayed on every deploy, on the session pooler, as the LAST migration file", () => {
  const line = `run_psql_session -f /migrations/${UP}`;
  const block = prodMigrationBlock();
  assert.equal(workflow.split(`/migrations/${UP}`).length - 1, 1, "applied once per deploy, and nowhere else");
  assert.ok(block.includes(line), "inside the prod block, via run_psql_session");

  const files = [...block.matchAll(/\/migrations\/(\d{6}_[a-z0-9_]+\.up\.sql)/g)].map((m) => m[1]);
  assert.equal(files.at(-1), UP, `the last file replayed must be ${UP}, so it re-closes what the others re-create`);
  assert.ok(block.indexOf(line) > block.indexOf("run_psql_session -f /migrations/000132_extend_fundamentals.up.sql"));
  assert.ok(block.indexOf(line) < block.indexOf("DELETE FROM schema_migrations"));
  assert.ok(!workflow.includes(DOWN));
});

// ---------------------------------------------------------------------------
// the read-only check

test("scripts/prod-data-api-check.sql is a read-only probe prod-psql.sh accepts", () => {
  assert.equal(classify(check, { probe: true }).verdict, "transaction");
  for (const stmt of topLevel(check)) {
    assert.match(stmt, /^WITH\b/, "one read-only WITH ... SELECT");
    assert.doesNotMatch(stmt, /\b(CREATE|DROP|ALTER|INSERT|UPDATE|DELETE|TRUNCATE|GRANT|REVOKE|BEGIN|COMMIT|ROLLBACK|SET|COPY|CALL|DO)\b/i);
  }
});

test("the check covers what the migration closes, with the same scope", () => {
  for (const violation of [
    "rls_disabled",
    "rls_forced",
    "policy_for_api_role",
    "relation_privilege",
    "sequence_privilege",
    "function_execute",
    "default_acl",
    "default_acl_public_execute",
  ]) {
    assert.match(check, new RegExp(`'${violation}'`), violation);
  }
  assert.match(check, /c\.relkind IN \('r', 'p', 'v', 'm', 'f', 'S'\)/);
  assert.match(check, /d\.classid = 'pg_class'::regclass AND d\.objid = c\.oid AND d\.deptype = 'e'/);
  assert.match(check, /d\.classid = 'pg_proc'::regclass AND d\.objid = p\.oid AND d\.deptype = 'e'/);
  // column-level grants count: PostgREST serves a table through them
  assert.match(check, /has_any_column_privilege\(api\.oid, rel\.oid, privs\.priv\)/);
  // roles come from pg_roles, so the check runs (and returns nothing for them) where they are missing
  assert.match(check, /SELECT oid, rolname FROM pg_roles WHERE rolname IN \('anon', 'authenticated'\)/);
  assert.doesNotMatch(code(check), /'(anon|authenticated|postgres)'::regrole/);
});

// ---------------------------------------------------------------------------
// every migration, so the Data API stays closed

const migrationFiles = readdirSync(migrationsDir)
  .filter((f) => /^\d{6}_.+\.(up|down)\.sql$/.test(f))
  .sort();
const versionOf = (file) => Number.parseInt(file.slice(0, 6), 10);
const THIS_VERSION = versionOf(UP);

/** The role names a GRANT ... TO lists, literally (a %s placeholder lists none). */
function literalGrantees(sql) {
  const out = [];
  for (const m of code(sql).matchAll(/\bGRANT\b[^;]*?\bTO\s+((?:"?[A-Za-z_][A-Za-z0-9_$]*"?\s*,\s*)*"?[A-Za-z_][A-Za-z0-9_$]*"?)/gi)) {
    for (const name of m[1].split(",")) out.push(name.trim().replace(/"/g, "").toLowerCase());
  }
  return out;
}

test("no migration grants anything to anon, authenticated or PUBLIC", () => {
  // A dynamic carry of an object's existing grants (000131, 000132:
  // format('GRANT %s ... TO %s%s', ...)) names no role and is allowed: after
  // 000138 there is nothing of anon's left to carry, and 000138 replays after
  // both. ALTER DEFAULT PRIVILEGES ... GRANT ... TO anon is caught here too.
  const offenders = [];
  for (const file of migrationFiles) {
    for (const grantee of literalGrantees(read(file))) {
      if (["anon", "authenticated", "public"].includes(grantee)) offenders.push(`${file}: GRANT ... TO ${grantee}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "The Supabase Data API serves anything anon or authenticated (or PUBLIC, which both inherit) can read or call, to anyone holding the project's anon key. Nothing in this repo uses the Data API. If one object is ever meant to be published through it, grant exactly that object to exactly one role in its own migration and change this test in the same change.",
  );
  // the matcher itself
  assert.deepEqual(literalGrantees("GRANT SELECT ON t TO service_role, anon;"), ["service_role", "anon"]);
  assert.deepEqual(literalGrantees("EXECUTE format('GRANT %s ON TABLE %I TO %s%s', a, b, CASE WHEN x THEN 'PUBLIC' END);"), []);
  assert.deepEqual(literalGrantees('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO "authenticated";'), ["authenticated"]);
});

test("no migration creates a policy, or forces or disables row level security", () => {
  const offenders = [];
  for (const file of migrationFiles) {
    const sql = code(read(file));
    if (/\bCREATE\s+POLICY\b/i.test(sql)) offenders.push(`${file}: CREATE POLICY`);
    if (/(?<!\bNO\s)\bFORCE\s+ROW\s+LEVEL\s+SECURITY\b/i.test(sql)) offenders.push(`${file}: FORCE ROW LEVEL SECURITY`);
    if (/\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b/i.test(sql)) offenders.push(`${file}: DISABLE ROW LEVEL SECURITY`);
  }
  assert.deepEqual(
    offenders,
    [],
    "Every table in public has row level security on and no policy, which denies every role that is neither the owner nor BYPASSRLS. A policy is the only way that opens a row to the Data API; FORCE would subject an owner to it.",
  );
});

/**
 * Every routine definition in a file: { name, definer, pinned }. The name is
 * read outside the body, as are SECURITY DEFINER and SET search_path, which
 * the lexer leaves visible (only strings and dollar bodies are masked).
 */
function routineDefinitions(sql) {
  const defs = [];
  const stmts = topLevel(sql);
  for (const stmt of stmts) {
    const create = stmt.match(/^CREATE (?:OR REPLACE )?(?:FUNCTION|PROCEDURE) ((?:"i"|[A-Za-z0-9_]+)(?:\.(?:"i"|[A-Za-z0-9_]+))?)\s*\(/i);
    const alter = stmt.match(/^ALTER (?:FUNCTION|PROCEDURE|ROUTINE) ((?:"i"|[A-Za-z0-9_]+)(?:\.(?:"i"|[A-Za-z0-9_]+))?)\b/i);
    const m = create ?? alter;
    if (!m) continue;
    const name = m[1].toLowerCase().replace(/^public\./, "");
    defs.push({
      name,
      create: Boolean(create),
      definer: /\bSECURITY DEFINER\b/i.test(stmt),
      pinned: /\bSET search_path\b/i.test(stmt),
    });
  }
  const revoked = (name) =>
    stmts.some(
      (s) =>
        /^REVOKE\b/i.test(s) &&
        /\bFROM\b.*\bPUBLIC\b/i.test(s) &&
        (new RegExp(`\\bON (FUNCTION|ROUTINE|PROCEDURE) (public\\.)?${name}\\b`, "i").test(s) ||
          /\bON ALL (FUNCTIONS|ROUTINES|PROCEDURES) IN SCHEMA\b/i.test(s)),
    );
  return { defs, revoked };
}

test("every SECURITY DEFINER function pins search_path and revokes PUBLIC's EXECUTE", () => {
  // A SECURITY DEFINER function in public runs as postgres (BYPASSRLS, owner
  // of everything) for whoever may call it, and a new function is callable by
  // PUBLIC until revoked. Forward-only, like PROD_APPLIED.md's BASELINE: the
  // definer functions in files before 000138 (refresh_all_materialized_views
  // in 000021, 000027 and 000028, and those files' downs) pin search_path but
  // revoke nothing. They are allowed only because a later up migration
  // redefines the function without SECURITY DEFINER (000095 is the definition
  // prod runs), and 000138 revokes PUBLIC's EXECUTE on whatever is left.
  const newest = new Map(); // routine name -> { version, definer } of its newest up definition
  for (const file of migrationFiles.filter((f) => f.endsWith(".up.sql"))) {
    for (const def of routineDefinitions(read(file)).defs.filter((d) => d.create)) {
      newest.set(def.name, { version: versionOf(file), definer: def.definer, file });
    }
  }

  const offenders = [];
  let historical = 0;
  for (const file of migrationFiles) {
    const { defs, revoked } = routineDefinitions(read(file));
    for (const def of defs.filter((d) => d.definer)) {
      if (!def.pinned && !defs.some((d) => d.name === def.name && d.pinned)) {
        offenders.push(`${file}: SECURITY DEFINER ${def.name} does not pin search_path`);
      }
      if (versionOf(file) >= THIS_VERSION) {
        if (!revoked(def.name)) offenders.push(`${file}: SECURITY DEFINER ${def.name} without REVOKE EXECUTE ... FROM PUBLIC`);
      } else {
        historical += 1;
        const latest = newest.get(def.name);
        if (!revoked(def.name) && (!latest || latest.definer)) {
          offenders.push(`${file}: SECURITY DEFINER ${def.name} is still a definer in its newest definition (${latest?.file}) and revokes nothing`);
        }
      }
    }
  }
  assert.deepEqual(offenders, []);
  assert.ok(historical > 0, "the historical definer bodies are still found (the matcher works)");
  assert.equal(newest.get("refresh_all_materialized_views")?.definer, false);
});
