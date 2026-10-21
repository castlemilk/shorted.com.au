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
// These pin the file's shape: a privileges transaction under SET LOCAL
// lock_timeout that lists its work first and refuses to start while a
// REFRESH, TRUNCATE or ALTER is in flight in public; then row level security
// one table per transaction, each with its own short lock_timeout, a handler
// for lock_not_available and deadlock_detected, and a COMMIT; and every
// role-dependent statement behind a pg_roles check. Every catalog query in the
// file, the in-flight look with its refusal, and the read-only check's scope
// and each of its classes are pinned WHOLE (whitespace aside), not by
// fragments: fragments let an inverted refusal, an extra AND in a WHERE clause
// or a class that skips views pass (the second review's mutations). Changing
// one changes verified SQL, so the same commit changes its pin here. They also
// pin what it covers, what makes a replay a no-op, its place at the END of the
// deploy allowlist, the read-only probes, and rules over every .sql file in the
// repository (the migrations, the legacy Supabase CLI directories that
// `supabase db push` would apply, analysis/, scripts/) that keep the Data API
// closed afterwards:
//   * none GRANTs anything to anon, authenticated or PUBLIC, or makes one of
//     them an object's owner;
//   * a GRANT whose grantee is computed (a format placeholder or a
//     concatenated string), which no scan can read, appears only in the
//     reviewed carries of an object's own grants (000131, 000132);
//   * none creates a policy, or FORCEs or DISABLEs row level security;
//   * every SECURITY DEFINER function in a migration pins search_path and
//     revokes PUBLIC's EXECUTE in the same file.
// The behaviour itself was exercised against Postgres 15 built with prod's
// role model and default privileges plus the whole migration chain: applied
// twice through prod-psql.sh (the second run rewrote no catalog row), the
// deploy block replayed twice, a no-op under golang-migrate where the roles do
// not exist and the documented invalid_transaction_termination where they do,
// anon and authenticated denied on every object kind, the backend unaffected;
// a refresh, TRUNCATE or ALTER in flight refused at once with nothing changed;
// readers of other tables not held up while one table waits; and the deadlock
// a single RLS transaction allowed gone.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { classify, splitStatements } from "../../scripts/prod-psql-classify.mjs";

const migrationsDir = new URL("./", import.meta.url);
const repoRoot = new URL("../../", import.meta.url);
const read = (name) => readFileSync(new URL(name, migrationsDir), "utf8");
const readRepo = (path) => readFileSync(new URL(path, repoRoot), "utf8");
const UP = "000138_harden_data_api_grants.up.sql";
const DOWN = "000138_harden_data_api_grants.down.sql";
const up = read(UP);
const down = read(DOWN);
const workflow = readRepo(".github/workflows/terraform-deploy.yml");
const check = readRepo("scripts/prod-data-api-check.sql");
const precheck = readRepo("scripts/prod-data-api-precheck.sql");
const progress = readRepo("scripts/prod-data-api-progress.sql");
const runbook = readRepo("docs/operations/supabase-data-api.md");

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

/** Single-quoted literals inside the DO bodies ('' is an escaped quote). */
const STRING = /'(?:[^']|'')*'/g;
/** The code with every literal masked, so a message never satisfies or trips a keyword test. */
const masked = (sql) => sql.replace(STRING, "'s'");
/** The SQL the blocks hand to EXECUTE: every literal that starts with a statement verb. */
const statementStrings = (sql) =>
  [...sql.matchAll(STRING)]
    .map((m) => m[0].slice(1, -1))
    .filter((s) => /^(REVOKE|ALTER|GRANT|CREATE|DROP|INSERT|UPDATE|DELETE|TRUNCATE|COMMENT|VACUUM|REINDEX|CLUSTER|SET|DO|CALL|SELECT)\b/i.test(s));

const ROLE_GUARD = /FROM pg_roles\s+WHERE rolname IN \('anon', 'authenticated'\)/;
const CATALOG_WRITER_MODES = "l.mode IN ('ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')";

/** Whitespace collapsed, so a pinned clause compares tokens, not layout. */
const words = (text) => text.replace(/\s+/g, " ").trim();

/**
 * From `start` through the first `end` after it, whitespace collapsed. Fails
 * when either is missing, so a pinned clause that moves cannot pass by
 * comparing nothing.
 */
function span(text, start, end) {
  const from = text.indexOf(start);
  assert.ok(from >= 0, `expected to find: ${start}`);
  const to = text.indexOf(end, from + start.length);
  assert.ok(to >= 0, `expected to find, after "${start}": ${end}`);
  return words(text.slice(from, to + end.length));
}

/**
 * The text with everything inside parentheses or quotes blanked out, at the
 * same length so its indices are the text's: what is left is the statement's
 * own level, where a CTE starts, a UNION ALL joins two classes and a FROM
 * names a class's rows.
 */
function topLevelMask(text) {
  let out = "";
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < text.length && !(text[j] === ch && text[j + 1] !== ch)) j += text[j] === ch ? 2 : 1;
      out += " ".repeat(j + 1 - i);
      i = j;
    } else if (ch === "(") {
      out += depth === 0 ? ch : " ";
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
      out += depth === 0 ? ch : " ";
    } else {
      out += depth === 0 ? ch : " ";
    }
  }
  return out;
}

/** The text cut at every top-level match of `re` (a /g regex), the matches dropped. */
function splitTopLevel(text, re) {
  const cuts = [...topLevelMask(text).matchAll(re)];
  const parts = [];
  let from = 0;
  for (const m of cuts) {
    parts.push(text.slice(from, m.index));
    from = m.index + m[0].length;
  }
  parts.push(text.slice(from));
  return parts;
}

// ---------------------------------------------------------------------------
// shape

test("a privileges transaction, then the row level security block, and nothing else at top level", () => {
  assert.deepEqual(topLevel(up), ["BEGIN", "SET LOCAL lock_timeout = 's'", "DO $body$", "COMMIT", "DO $body$"]);
  assert.equal(bodies.length, 2, "expected the privileges block and the row level security block");
});

test("lock_timeout is short, and scoped: step 1 by SET LOCAL, each table by set_config(..., true)", () => {
  // An ACCESS EXCLUSIVE wait queues every new reader of the table behind it.
  const stepOne = [...upCode.matchAll(/SET LOCAL lock_timeout = '(\d+)s';/g)].map((m) => Number(m[1]));
  const perTable = [...rls.matchAll(/PERFORM set_config\('lock_timeout', '(\d+)s', true\);/g)].map((m) => Number(m[1]));
  assert.equal(stepOne.length, 1, "one SET LOCAL lock_timeout, for the privileges transaction");
  assert.equal(perTable.length, 1, "one transaction-local lock_timeout per table, set inside the loop");
  for (const seconds of [...stepOne, ...perTable]) {
    assert.ok(seconds >= 1 && seconds <= 5, `lock_timeout ${seconds}s: keep it between 1s and 5s`);
  }
  // Nothing else sets it: outside its messages the file names lock_timeout
  // only in that SET LOCAL (the set_config argument is a literal, so masked).
  assert.equal([...masked(upCode).matchAll(/lock_timeout/g)].length, 1);
  assert.equal([...upCode.matchAll(/set_config\(/g)].length, 1);
  assert.doesNotMatch(upCode, /set_config\('lock_timeout'[^)]*false\)/, "is_local false would outlive the table's transaction");
  // A session-level SET would outlive the file (the deploy runs several files
  // in one psql session); SET LOCAL ends with its transaction on any pooler.
  assert.doesNotMatch(upCode, /^\s*SET (?!LOCAL)/m);
  assert.doesNotMatch(upCode, /statement_timeout/, "the catalog work is quick; the wrapper owns statement_timeout");
});

test("prod-psql.sh reads it as `session`, so it runs the file statement by statement, as psql -f does", () => {
  // The row level security block COMMITs, which a DO can do only outside a
  // transaction block. The `transaction` verdict would run the file under
  // --single-transaction; `session` runs it statement by statement.
  const verdict = classify(up);
  assert.equal(verdict.verdict, "session");
  assert.match(verdict.reason, /manages its own transactions/);
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

  // golang-migrate sends the file as one multi-statement query, where a COMMIT
  // inside a DO fails; on a server without the roles the block must return
  // before its first COMMIT, so the file stays a no-op there.
  const rlsExit = rls.indexOf("IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('anon', 'authenticated')) THEN");
  assert.ok(rlsExit > 0, "row level security block: early exit");
  assert.match(rls.slice(rlsExit, rls.indexOf("END IF;", rlsExit)), /RETURN;/);
  assert.doesNotMatch(rls.slice(0, rlsExit), /\b(EXECUTE|COMMIT|set_config)\b/, "nothing runs before the check");
});

test("postgres's default privileges change only once the role exists and current_user can act for it", () => {
  const exists = privileges.indexOf("IF pg_oid IS NULL THEN");
  const member = privileges.indexOf("ELSIF NOT pg_has_role(current_user, 'postgres', 'MEMBER') THEN");
  const first = privileges.indexOf("ALTER DEFAULT PRIVILEGES");
  assert.ok(exists > 0 && member > exists && first > member, "role check, then membership check, then the ALTERs");
  assert.match(privileges, /pg_oid\s+oid := \(SELECT oid FROM pg_roles WHERE rolname = 'postgres'\);/);
  // Never a cast from a role name, which errors where the role is missing.
  assert.doesNotMatch(upCode, /'(anon|authenticated|postgres|service_role)'::regrole/);
  // Each ALTER DEFAULT PRIVILEGES is a string put on the work list, which only
  // EXECUTE runs, so the block compiles and runs on a server without the role.
  const alters = [...privileges.matchAll(/ALTER DEFAULT PRIVILEGES/g)].map((m) => m.index);
  assert.equal(alters.length, 2);
  for (const at of alters) {
    assert.match(privileges.slice(Math.max(0, at - 30), at), /todo := todo \|\| (format\()?'$/, "ALTER DEFAULT PRIVILEGES onto the work list");
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

/**
 * Every catalog query 000138 runs, and the in-flight look with its refusal
 * and the run, pinned whole: { what, body, start, end, sql }, the SQL copied
 * from the file as it was verified on the prod-like rig.
 */
const PINNED_SQL = [
  {
    what: "the PostgREST roles that exist",
    body: privileges,
    start: "SELECT array_agg(oid ORDER BY rolname)",
    end: ";",
    sql: `
    SELECT array_agg(oid ORDER BY rolname), string_agg(format('%I', rolname), ', ' ORDER BY rolname)
      INTO api_oids, api_roles
      FROM pg_roles
     WHERE rolname IN ('anon', 'authenticated');`,
  },
  {
    what: "schema public",
    body: privileges,
    start: "public_oid  oid :=",
    end: ";",
    sql: `public_oid  oid := (SELECT oid FROM pg_namespace WHERE nspname = 'public');`,
  },
  {
    what: "step 1a, the relations to revoke on",
    body: privileges,
    start: "SELECT n.nspname, c.relname, c.relkind, c.relowner",
    end: "LOOP",
    sql: `
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
    LOOP`,
  },
  {
    what: "step 1b, the routines to revoke on",
    body: privileges,
    start: "SELECT n.nspname, p.proname, p.proowner, oidvectortypes(p.proargtypes) AS args",
    end: "LOOP",
    sql: `
        SELECT n.nspname, p.proname, p.proowner, oidvectortypes(p.proargtypes) AS args
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE p.pronamespace = public_oid
           AND NOT EXISTS (SELECT 1 FROM pg_depend d
                            WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
           AND EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                        WHERE a.grantee = 0 OR a.grantee = ANY (api_oids))
         ORDER BY p.proname, 4
    LOOP`,
  },
  {
    what: "step 2, postgres's default-privilege entries to close",
    body: privileges,
    start: "SELECT d.defaclobjtype, d.defaclnamespace = 0 AS everywhere",
    end: "LOOP",
    sql: `
            SELECT d.defaclobjtype, d.defaclnamespace = 0 AS everywhere
              FROM pg_default_acl d
             WHERE d.defaclrole = pg_oid
               AND d.defaclnamespace IN (public_oid, 0)
               AND d.defaclobjtype IN ('r', 'S', 'f')
               AND EXISTS (SELECT 1 FROM aclexplode(d.defaclacl) a WHERE a.grantee = ANY (api_oids))
             ORDER BY 2, 1
        LOOP`,
  },
  {
    what: "step 2, the schema-less EXECUTE to PUBLIC",
    body: privileges,
    start: "IF EXISTS (SELECT 1",
    end: "::text;",
    sql: `
        IF EXISTS (SELECT 1
                     FROM aclexplode(coalesce(
                            (SELECT d.defaclacl FROM pg_default_acl d
                              WHERE d.defaclrole = pg_oid AND d.defaclnamespace = 0 AND d.defaclobjtype = 'f'),
                            acldefault('f', pg_oid))) a
                    WHERE a.grantee = 0) THEN
            todo := todo || 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC'::text;`,
  },
  {
    what: "step 2, another role's default privileges, reported",
    body: privileges,
    start: "SELECT pg_get_userbyid(d.defaclrole) AS for_role",
    end: "LOOP",
    sql: `
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
    LOOP`,
  },
  {
    // A plain JOIN would hide a prepared transaction's locks, an extra AND
    // (AND l.fastpath, AND c.relkind <> 'm', AND false) would hide a refresh,
    // and IF in_flight IS NULL would refuse only when nothing is running.
    what: "step 3, the in-flight look, the refusal and the run",
    body: privileges,
    start: "IF cardinality(todo) > 0 THEN",
    end: "END LOOP;",
    sql: `
    IF cardinality(todo) > 0 THEN
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
        END LOOP;`,
  },
  {
    // AND c.relkind = 'r' alone would skip partitioned tables
    what: "row level security, the tables to enable it on",
    body: rls,
    start: "FOR t IN",
    end: "LOOP",
    sql: `
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
    LOOP`,
  },
];

test("every catalog query, and the in-flight look with its refusal, are pinned whole", () => {
  for (const { what, body, start, end, sql } of PINNED_SQL) {
    assert.equal(
      span(body, start, end),
      words(sql),
      `000138, ${what}: the file no longer matches its pin. It was verified as it stands on a prod-like rig, so change the pin only with a re-verification.`,
    );
  }
  // the run is the last thing step 3 does, and step 3 is the block's last work
  assert.match(privileges, /EXECUTE stmt;\s+END LOOP;\s+END IF;\s+RAISE NOTICE '000138: revoked/);
});

test("relations: tables, partitioned tables, views, materialized views, foreign tables and sequences", () => {
  // the planning loop's own clause (the in-flight look repeats the list)
  assert.match(privileges, /WHERE c\.relnamespace = public_oid\n\s+AND c\.relkind IN \('r', 'p', 'v', 'm', 'f', 'S'\)\n\s+AND NOT EXISTS \(SELECT 1 FROM pg_depend d/);
  assert.match(
    privileges,
    /todo := todo \|\| format\('REVOKE ALL ON %s %I\.%I FROM %s CASCADE',\s+CASE r\.relkind WHEN 'S' THEN 'SEQUENCE' ELSE 'TABLE' END,\s+r\.nspname, r\.relname, from_list\);/,
  );
  // PUBLIC as well as the two roles: anon inherits whatever PUBLIC holds.
  assert.match(privileges, /from_list := 'PUBLIC, ' \|\| api_roles;/);
});

test("routines: every function, procedure and aggregate, PUBLIC included", () => {
  assert.match(privileges, /todo := todo \|\| format\('REVOKE ALL ON ROUTINE %I\.%I\(%s\) FROM %s CASCADE',\s+r\.nspname, r\.proname, r\.args, from_list\);/);
  // The argument list is the input types only, the identity GRANT/REVOKE take.
  assert.match(privileges, /oidvectortypes\(p\.proargtypes\) AS args/);
  assert.doesNotMatch(privileges, /p\.prokind/, "no routine kind is skipped");
});

test("default privileges: postgres's entries for public and its schema-less ones, and the schema-less EXECUTE to PUBLIC", () => {
  assert.match(privileges, /d\.defaclnamespace IN \(public_oid, 0\)/);
  assert.match(privileges, /d\.defaclnamespace = 0 AS everywhere/);
  assert.match(privileges, /d\.defaclobjtype IN \('r', 'S', 'f'\)/);
  assert.match(
    privileges,
    /todo := todo \|\| format\('ALTER DEFAULT PRIVILEGES FOR ROLE postgres %sREVOKE ALL ON %s FROM %s',\s+CASE WHEN r\.everywhere THEN '' ELSE 'IN SCHEMA public ' END,\s+CASE r\.defaclobjtype WHEN 'r' THEN 'TABLES' WHEN 'S' THEN 'SEQUENCES' ELSE 'FUNCTIONS' END,\s+api_roles\);/,
  );
  // A per-schema default can only add to the built-in one (EXECUTE to PUBLIC),
  // so closing new functions to PUBLIC takes the schema-less form.
  assert.match(privileges, /todo := todo \|\| 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC'::text;/);
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
  const statements = [...statementStrings(privileges), ...statementStrings(rls)];
  assert.equal(statements.length, 5, "two REVOKEs and two ALTER DEFAULT PRIVILEGES on the work list, one ALTER TABLE");
  for (const stmt of statements) {
    // ALTER DEFAULT PRIVILEGES interpolates no object name: a fixed clause or
    // keyword (from a CASE) and the role list, itself built with format('%I');
    // the "default privileges" test pins both.
    if (/^ALTER DEFAULT PRIVILEGES/.test(stmt)) continue;
    assert.match(stmt, /^(REVOKE ALL ON|ALTER TABLE)/, stmt);
    assert.match(stmt, /%I\.%I/, stmt);
  }
  // Nothing reaches the server except through those strings: the privileges
  // block EXECUTEs only its work list, the row level security block only its
  // ALTER TABLE (literals masked, so `REVOKE EXECUTE ON` inside one is not counted).
  assert.deepEqual([...masked(privileges).matchAll(/\bEXECUTE\s+(\w+)/g)].map((m) => m[1]), ["stmt"]);
  assert.deepEqual([...masked(rls).matchAll(/\bEXECUTE\s+(\w+)/g)].map((m) => m[1]), ["format"]);
  assert.doesNotMatch(upCode, /quote_ident\(|EXECUTE\s+'[^']*'\s*\|\|/, "no hand-built identifiers");
  assert.match(privileges, /string_agg\(format\('%I', rolname\), ', ' ORDER BY rolname\)/);
});

// ---------------------------------------------------------------------------
// replay-safe: prod replays it on every deploy

test("idempotent statements only: nothing is created, dropped, granted or written", () => {
  const forbidden = /\b(CREATE|DROP|INSERT|UPDATE|DELETE|TRUNCATE|GRANT|COMMENT|VACUUM|REINDEX|CLUSTER)\b/i;
  // the PL/pgSQL itself, with every message masked ...
  assert.doesNotMatch(masked(upCode), forbidden);
  // ... and every statement it hands to EXECUTE
  for (const stmt of [...statementStrings(privileges), ...statementStrings(rls)]) {
    assert.match(stmt, /^(REVOKE ALL ON |ALTER DEFAULT PRIVILEGES FOR ROLE postgres |ALTER TABLE IF EXISTS %I\.%I ENABLE ROW LEVEL SECURITY$)/, stmt);
    assert.doesNotMatch(stmt.replace(/^ALTER (DEFAULT PRIVILEGES|TABLE)/, ""), forbidden, stmt);
  }
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

test("step 1 lists its work, refuses while a REFRESH, TRUNCATE or ALTER is in flight, then runs the list", () => {
  // A REVOKE takes no lock, but it rewrites the object's catalog row and so
  // waits for a transaction that has rewritten that row: a refresh (CONCURRENTLY
  // too), TRUNCATE or ALTER, each holding one of these modes until it commits.
  const gate = privileges.indexOf("IF cardinality(todo) > 0 THEN");
  const look = privileges.indexOf("FROM pg_locks l", gate);
  const refuse = privileges.indexOf("RAISE EXCEPTION USING", gate);
  const run = privileges.indexOf("FOREACH stmt IN ARRAY todo LOOP");
  const lastPlanned = Math.max(...[...privileges.matchAll(/todo := todo \|\|/g)].map((m) => m.index));
  assert.ok(gate > lastPlanned, "the look comes after the whole list is built");
  assert.ok(gate > 0 && look > gate && refuse > look && run > refuse, "nothing to do: no look; then look, refuse, run");
  const query = privileges.slice(look, refuse);
  for (const condition of [
    "l.locktype = 'relation'",
    "AND l.granted",
    "AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())",
    `AND ${CATALOG_WRITER_MODES}`,
    "AND l.pid IS DISTINCT FROM pg_backend_pid()",
    "AND a.backend_type IS DISTINCT FROM 'autovacuum worker'",
    "AND c.relnamespace = public_oid",
    "AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')",
  ]) {
    assert.ok(query.includes(condition), `the in-flight look must keep: ${condition}`);
  }
  assert.match(privileges.slice(refuse, run), /ERRCODE = 'object_in_use',\s+MESSAGE = format\('000138: a REFRESH, TRUNCATE or ALTER is in flight in schema public, so nothing was changed: %s', in_flight\)/);
  assert.match(privileges, /FOREACH stmt IN ARRAY todo LOOP\n\s+EXECUTE stmt;\n\s+END LOOP;/);
  assert.equal([...upCode.matchAll(/\bRAISE EXCEPTION\b/g)].length, 1, "the refusal is the file's one RAISE EXCEPTION");
  // Step 1 is one transaction: nothing in it commits.
  assert.doesNotMatch(privileges, /\b(COMMIT|ROLLBACK)\b/);
});

test("row level security: one transaction per table, a contended table skipped with a WARNING, nothing else swallowed", () => {
  assert.equal([...upCode.matchAll(/\bEXCEPTION WHEN\b/g)].length, 1, "one handler in the whole file");
  // set the table's own lock_timeout, flip it in a subtransaction that catches
  // only a lock it cannot get or a deadlock, then COMMIT outside that block
  // (a transaction cannot end inside a block with an EXCEPTION clause)
  assert.match(
    rls,
    /PERFORM set_config\('lock_timeout', '\d+s', true\);[^\n]*\n\s+BEGIN\n\s+EXECUTE format\('ALTER TABLE IF EXISTS %I\.%I ENABLE ROW LEVEL SECURITY'[^\n]*\n[^\n]*\n\s+EXCEPTION WHEN lock_not_available OR deadlock_detected THEN\n\s+deferred := deferred \|\| format\('%I\.%I', t\.nspname, t\.relname\);\n\s+END;\n(?:[ \t]*\n)*[ \t]+COMMIT;\n\s+END LOOP;/,
  );
  assert.equal([...rls.matchAll(/\bCOMMIT\b/g)].length, 1, "the per-table COMMIT is the block's only one");
  assert.doesNotMatch(upCode, /WHEN OTHERS/i, "a real error must fail the step");
  assert.match(rls, /RAISE WARNING '000138: row level security NOT enabled on % table\(s\) whose lock was not granted within lock_timeout, or whose wait was chosen to break a deadlock: %/);
  // The deploy workflow that would replay it is disabled: the WARNING tells
  // the operator to re-run, and never to wait for a deploy.
  const warning = rls.slice(rls.indexOf("RAISE WARNING"), rls.indexOf("cardinality(deferred), array_to_string"));
  assert.match(warning, /until scripts\/prod-data-api-check\.sql returns zero rows/);
  assert.doesNotMatch(warning, /deploy/i);
});

test("with one transaction per table the order decides nothing; tables are taken by name, for a stable log", () => {
  assert.match(rls, /ORDER BY c\.relname\n\s+LOOP/);
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
// the read-only check and pre-checks

for (const [name, sql] of [
  ["scripts/prod-data-api-check.sql", check],
  ["scripts/prod-data-api-precheck.sql", precheck],
  ["scripts/prod-data-api-progress.sql", progress],
]) {
  test(`${name} is a read-only probe prod-psql.sh accepts`, () => {
    assert.equal(classify(sql, { probe: true }).verdict, "transaction");
    const stmts = topLevel(sql);
    assert.equal(stmts.length, 1, "one statement");
    assert.match(stmts[0], /^WITH\b/, "one read-only WITH ... SELECT");
    assert.doesNotMatch(stmts[0], /\b(CREATE|DROP|ALTER|INSERT|UPDATE|DELETE|TRUNCATE|GRANT|REVOKE|BEGIN|COMMIT|ROLLBACK|SET|COPY|CALL|DO)\b/i);
    // no backslash anywhere, so it reads the same whatever standard_conforming_strings is
    assert.doesNotMatch(code(sql), /\\/);
  });
}

test("the check covers what the migration closes, with the same scope, and what it cannot", () => {
  for (const violation of [
    "rls_disabled",
    "rls_forced",
    "policy_for_api_role",
    "relation_privilege",
    "sequence_privilege",
    "function_execute",
    "extension_relation_privilege",
    "default_acl",
    "default_acl_global",
    "default_acl_public_execute",
    "default_acl_public_grant",
  ]) {
    assert.match(check, new RegExp(`SELECT '${violation}'`), violation);
  }
  // A default that grants PUBLIC (which anon and authenticated inherit) is
  // reported even though 000138 closes only the schema-less EXECUTE on
  // functions: per-schema entries in public of any kind, and schema-less ones
  // for tables and sequences (functions there are default_acl_public_execute).
  assert.match(
    check,
    /SELECT 'default_acl_public_grant',[\s\S]*?WHERE d\.defaclrole = \(SELECT oid FROM pg\)\s+AND \(d\.defaclnamespace = 'public'::regnamespace\s+OR \(d\.defaclnamespace = 0 AND d\.defaclobjtype IN \('r', 'S'\)\)\)\s+AND d\.defaclobjtype IN \('r', 'S', 'f'\)\s+AND EXISTS \(SELECT 1 FROM aclexplode\(d\.defaclacl\) a WHERE a\.grantee = 0\)\n\)/,
  );
  assert.match(check, /c\.relkind IN \('r', 'p', 'v', 'm', 'f', 'S'\)/);
  // our relations and functions: extension members excluded, as in the migration
  assert.match(check, /rel AS \([\s\S]*?NOT EXISTS \(SELECT 1 FROM pg_depend d\s+WHERE d\.classid = 'pg_class'::regclass AND d\.objid = c\.oid AND d\.deptype = 'e'\)/);
  assert.match(check, /fn AS \([\s\S]*?NOT EXISTS \(SELECT 1 FROM pg_depend d\s+WHERE d\.classid = 'pg_proc'::regclass AND d\.objid = p\.oid AND d\.deptype = 'e'\)/);
  // ... but an extension's relations are reported, since the migration cannot close them
  assert.match(check, /ext_rel AS \(\s+SELECT [^)]*\s+FROM pg_class c\s+JOIN pg_depend d ON d\.classid = 'pg_class'::regclass AND d\.objid = c\.oid AND d\.deptype = 'e'/);
  // postgres's schema-less defaults, which the migration closes too
  assert.match(check, /SELECT 'default_acl_global',[\s\S]*?AND d\.defaclnamespace = 0\s+AND d\.defaclobjtype IN \('r', 'S', 'f'\)/);
  // column-level grants count: PostgREST serves a table through them
  assert.match(check, /has_any_column_privilege\(api\.oid, rel\.oid, privs\.priv\)/);
  assert.match(check, /has_any_column_privilege\(api\.oid, ext_rel\.oid, p\.priv\)/);
  // roles come from pg_roles, so the check runs where they are missing, and
  // reports nothing there (no Data API)
  assert.match(check, /SELECT oid, rolname FROM pg_roles WHERE rolname IN \('anon', 'authenticated'\)/);
  assert.match(check, /FROM violations\s+WHERE EXISTS \(SELECT 1 FROM api\)\s+ORDER BY/);
  assert.doesNotMatch(code(check), /'(anon|authenticated|postgres)'::regrole/);
});

/** The check's scope: its CTEs before `violations`, pinned whole. */
const CHECK_SCOPE = {
  api: `SELECT oid, rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')`,
  pg: `SELECT oid FROM pg_roles WHERE rolname = 'postgres'`,
  rel: `
    SELECT c.oid, c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c
     WHERE c.relnamespace = 'public'::regnamespace
       AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
       AND NOT EXISTS (SELECT 1 FROM pg_depend d
                        WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')`,
  ext_rel: `
    SELECT c.oid, c.relname, c.relkind, c.relrowsecurity, e.extname
      FROM pg_class c
      JOIN pg_depend d ON d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'
                      AND d.refclassid = 'pg_extension'::regclass
      JOIN pg_extension e ON e.oid = d.refobjid
     WHERE c.relnamespace = 'public'::regnamespace
       AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')`,
  fn: `
    SELECT p.oid, p.proname, p.proowner, p.proacl, p.prosecdef, oidvectortypes(p.proargtypes) AS args
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND NOT EXISTS (SELECT 1 FROM pg_depend d
                        WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')`,
  privs: `SELECT unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) AS priv`,
};

/**
 * Each class's rows: its branch of `violations` from its own FROM to its end,
 * so the joins, the LATERAL that decides who holds what, and the WHERE clause
 * are all pinned. Only the SELECT list (the row's wording) is free to change.
 */
const CHECK_CLASSES = {
  rls_disabled: `
      FROM rel
     WHERE rel.relkind IN ('r', 'p') AND NOT rel.relrowsecurity`,
  rls_forced: `
      FROM rel
     WHERE rel.relkind IN ('r', 'p') AND rel.relforcerowsecurity`,
  policy_for_api_role: `
      FROM pg_policy pol
      JOIN pg_class c ON c.oid = pol.polrelid
     WHERE c.relnamespace = 'public'::regnamespace
       AND (0 = ANY (pol.polroles) OR pol.polroles && ARRAY(SELECT oid FROM api))`,
  relation_privilege: `
      FROM rel
     CROSS JOIN api
     CROSS JOIN LATERAL (
            SELECT string_agg(privs.priv, ',' ORDER BY privs.priv) AS list
              FROM privs
             WHERE CASE WHEN privs.priv IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
                        THEN has_any_column_privilege(api.oid, rel.oid, privs.priv)
                        ELSE has_table_privilege(api.oid, rel.oid, privs.priv) END
          ) held
     WHERE rel.relkind <> 'S' AND held.list IS NOT NULL`,
  sequence_privilege: `
      FROM rel
     CROSS JOIN api
     WHERE rel.relkind = 'S'
       AND (has_sequence_privilege(api.oid, rel.oid, 'USAGE')
            OR has_sequence_privilege(api.oid, rel.oid, 'SELECT')
            OR has_sequence_privilege(api.oid, rel.oid, 'UPDATE'))`,
  function_execute: `
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
     WHERE who.list IS NOT NULL`,
  extension_relation_privilege: `
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
     WHERE held.list IS NOT NULL`,
  default_acl: `
      FROM pg_default_acl d
     WHERE d.defaclrole = (SELECT oid FROM pg)
       AND d.defaclnamespace = 'public'::regnamespace
       AND d.defaclobjtype IN ('r', 'S', 'f')
       AND EXISTS (SELECT 1 FROM aclexplode(d.defaclacl) a WHERE a.grantee IN (SELECT oid FROM api))`,
  default_acl_global: `
      FROM pg_default_acl d
     WHERE d.defaclrole = (SELECT oid FROM pg)
       AND d.defaclnamespace = 0
       AND d.defaclobjtype IN ('r', 'S', 'f')
       AND EXISTS (SELECT 1 FROM aclexplode(d.defaclacl) a WHERE a.grantee IN (SELECT oid FROM api))`,
  default_acl_public_execute: `
      FROM pg
     WHERE EXISTS (SELECT 1
                     FROM aclexplode(coalesce(
                            (SELECT d.defaclacl FROM pg_default_acl d
                              WHERE d.defaclrole = pg.oid AND d.defaclnamespace = 0 AND d.defaclobjtype = 'f'),
                            acldefault('f', pg.oid))) a
                    WHERE a.grantee = 0)`,
  default_acl_public_grant: `
      FROM pg_default_acl d
     WHERE d.defaclrole = (SELECT oid FROM pg)
       AND (d.defaclnamespace = 'public'::regnamespace
            OR (d.defaclnamespace = 0 AND d.defaclobjtype IN ('r', 'S')))
       AND d.defaclobjtype IN ('r', 'S', 'f')
       AND EXISTS (SELECT 1 FROM aclexplode(d.defaclacl) a WHERE a.grantee = 0)`,
};

test("the check's scope and every class's rows are pinned whole", () => {
  // A class that skips views (relkind NOT IN ('S', 'v')), a function_execute
  // that no longer sees PUBLIC, an rls_disabled that skips partitioned tables:
  // each reads "closed" while something is open.
  const text = code(check);
  const mask = topLevelMask(text);
  const ctes = new Map();
  let last = -1;
  for (const m of mask.matchAll(/\b(\w+) AS \(/g)) {
    const open = m.index + m[0].length - 1;
    last = mask.indexOf(")", open);
    ctes.set(m[1], text.slice(open + 1, last));
  }
  assert.deepEqual([...ctes.keys()], [...Object.keys(CHECK_SCOPE), "violations"], "the check's CTEs");
  for (const [name, sql] of Object.entries(CHECK_SCOPE)) {
    assert.equal(words(ctes.get(name)), words(sql), `scripts/prod-data-api-check.sql: the ${name} CTE no longer matches its pin`);
  }
  const classes = splitTopLevel(ctes.get("violations"), /\bUNION ALL\b/g).map((branch) => [
    /^\s*SELECT '(\w+)'/.exec(branch)?.[1],
    words(branch.slice(topLevelMask(branch).search(/\bFROM\b/))),
  ]);
  assert.deepEqual(classes.map(([name]) => name).sort(), Object.keys(CHECK_CLASSES).sort(), "one branch per class");
  for (const [name, rows] of classes) {
    assert.equal(rows, words(CHECK_CLASSES[name]), `scripts/prod-data-api-check.sql: ${name}'s rows no longer match their pin`);
  }
  assert.equal(
    words(text.slice(last + 1)),
    "SELECT violation, object, detail FROM violations WHERE EXISTS (SELECT 1 FROM api) ORDER BY violation, object, detail;",
  );
});

test("the pre-check matches what step 1 refuses on, and the same query is in 000138's header and the runbook", () => {
  for (const condition of [
    "l.locktype = 'relation'",
    "AND l.granted",
    "AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())",
    "AND c.relnamespace = 'public'::regnamespace",
    CATALOG_WRITER_MODES,
    "c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')",
    "a.pid <> pg_backend_pid()",
    "a.backend_type IS DISTINCT FROM 'autovacuum worker'",
  ]) {
    assert.ok(precheck.includes(condition), `pre-check: ${condition}`);
  }
  // the RLS step's hazard too: a transaction older than lock_timeout on a table it will alter
  assert.match(precheck, /FILTER \(WHERE c\.relkind IN \('r', 'p'\) AND NOT c\.relrowsecurity\) AS rls_off/);
  assert.match(precheck, /a\.xact_start < now\(\) - interval '3 seconds'/);

  const words = (text) => text.replace(/\s+/g, " ").trim();
  const query = words(code(precheck));
  const header = words(up.slice(0, up.indexOf("\nBEGIN;")).replace(/^--[ \t]?/gm, ""));
  assert.ok(header.includes(query), "000138's header must carry the pre-check verbatim");
  const sqlBlocks = [...runbook.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => words(code(m[1])));
  assert.ok(sqlBlocks.includes(query), "docs/operations/supabase-data-api.md must carry the pre-check verbatim");
});

test("the optional progress pre-check sees every in-place pg_class writer in public, and rows it cannot place", () => {
  // Before PostgreSQL 15.9 (prod ran 15.6) an in-place pg_class update by
  // VACUUM, ANALYZE or CREATE INDEX can be lost to a concurrent update of the
  // same row, as by a REVOKE. Autovacuum counts: the write matters, not a lock.
  const sql = code(progress);
  for (const view of ["pg_stat_progress_vacuum", "pg_stat_progress_analyze", "pg_stat_progress_create_index"]) {
    assert.match(sql, new RegExp(`\\bFROM ${view}\\b`), view);
  }
  assert.match(sql, /\n  LEFT JOIN pg_class c ON c\.oid = p\.relid\n WHERE p\.datid = \(SELECT oid FROM pg_database WHERE datname = current_database\(\)\)\n   AND \(c\.oid IS NULL OR c\.relnamespace = 'public'::regnamespace\)\n/);
  assert.doesNotMatch(sql, /autovacuum|backend_type/);
});

test("the apply procedure: psql statement by statement, -X wherever psql -f is named, and the progress pre-check", () => {
  const header = up.slice(0, up.indexOf("\nBEGIN;"));
  for (const [name, text] of [["000138's header", header], ["the runbook", runbook]]) {
    const prose = words(text.replace(/^--[ \t]?/gm, ""));
    assert.match(text, /psql -X -v ON_ERROR_STOP=1 -f/, `${name}: the psql recipe`);
    assert.doesNotMatch(text, /psql -v ON_ERROR_STOP=1 -f/, `${name}: without -X, AUTOCOMMIT off in a ~/.psqlrc wraps the file in one transaction`);
    assert.match(prose, /Supabase MCP \(`?execute_sql`?, `?apply_migration`?\)/, `${name}: never through a route that sends the file as one query`);
    assert.ok(text.includes("scripts/prod-data-api-progress.sql"), `${name}: the optional progress pre-check`);
  }
});

// ---------------------------------------------------------------------------
// every SQL file in the repository, so the Data API stays closed

const migrationFiles = readdirSync(migrationsDir)
  .filter((f) => /^\d{6}_.+\.(up|down)\.sql$/.test(f))
  .sort();
const versionOf = (file) => Number.parseInt(file.slice(0, 6), 10);
const THIS_VERSION = versionOf(UP);

/**
 * Every .sql file in the repository, tracked or not, as sorted repo-relative
 * paths: whatever psql -f, a paste into a SQL editor or `supabase db push`
 * (web/package.json's `supabase:migrate`, which applies the legacy
 * supabase/ and web/supabase/ projects to whatever project is linked, prod
 * included) could run. Dependencies and dot-directories (.git, the .claude
 * worktrees, .next, .terraform) are skipped; a symlink is never followed.
 */
function repoSqlFiles(dir = "") {
  const out = [];
  for (const entry of readdirSync(dir ? new URL(`${dir}/`, repoRoot) : repoRoot, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...repoSqlFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".sql")) out.push(path);
  }
  return out.sort();
}
const sqlFiles = repoSqlFiles();
/** The read-only probes, one WITH ... SELECT each (tested above): they name what they look for. */
const READ_ONLY_PROBES = new Set(["scripts/prod-data-api-check.sql", "scripts/prod-data-api-precheck.sql", "scripts/prod-data-api-progress.sql"]);
const API_ROLES = ["anon", "authenticated", "public"];

/** The role names a GRANT ... TO lists, literally (a %s placeholder lists none). */
function literalGrantees(sql) {
  const out = [];
  for (const m of code(sql).matchAll(/\bGRANT\b[^;]*?\bTO\s+((?:"?[A-Za-z_][A-Za-z0-9_$]*"?\s*,\s*)*"?[A-Za-z_][A-Za-z0-9_$]*"?)/gi)) {
    for (const name of m[1].split(",")) out.push(name.trim().replace(/"/g, "").toLowerCase());
  }
  return out;
}

/** The role an ALTER ... OWNER TO names, literally (a %I placeholder names none). */
const literalOwners = (sql) =>
  [...code(sql).matchAll(/\bOWNER\s+TO\s+("?[A-Za-z_][A-Za-z0-9_$]*"?)/gi)].map((m) => m[1].replace(/"/g, "").toLowerCase());

/** GRANTs whose grantee is computed (a format placeholder, a concatenated string): no scan can read who they name. */
const computedGrants = (sql) => [...code(sql).matchAll(/\bGRANT\b[^;]*?\bTO\s+(?:%|'\s*\|\|)/gi)].length;

test("no SQL file grants anything to anon, authenticated or PUBLIC, or makes one of them an owner", () => {
  // ALTER DEFAULT PRIVILEGES ... GRANT ... TO anon is caught here too, and so
  // is a GRANT inside a function body: the scan reads everything but comments.
  const offenders = [];
  for (const path of sqlFiles) {
    const sql = readRepo(path);
    for (const grantee of literalGrantees(sql)) if (API_ROLES.includes(grantee)) offenders.push(`${path}: GRANT ... TO ${grantee}`);
    for (const owner of literalOwners(sql)) if (API_ROLES.includes(owner)) offenders.push(`${path}: OWNER TO ${owner}`);
  }
  assert.deepEqual(
    offenders,
    [],
    "The Supabase Data API serves anything anon or authenticated (or PUBLIC, which both inherit) can read or call, to anyone holding the project's anon key, and an owner holds everything on its object. Nothing in this repo uses the Data API. If one object is ever meant to be published through it, grant exactly that object to exactly one role in its own migration and change this test in the same change. Every .sql file is scanned, not only migrations: psql -f or `supabase db push` would run any of them.",
  );
  // the scan reaches every migration, the legacy file that used to grant
  // everything, the other legacy project, and SQL outside all of them
  assert.equal(sqlFiles.filter((p) => p.startsWith("services/migrations/")).length, migrationFiles.length);
  assert.ok(sqlFiles.includes("web/supabase/migrations/20250107_001_initial_schema.sql"));
  assert.ok(sqlFiles.some((p) => p.startsWith("supabase/migrations/")));
  assert.ok(sqlFiles.some((p) => p.startsWith("analysis/")));
  // the matchers themselves
  assert.deepEqual(literalGrantees("GRANT SELECT ON t TO service_role, anon;"), ["service_role", "anon"]);
  assert.deepEqual(literalGrantees("EXECUTE format('GRANT %s ON TABLE %I TO %s%s', a, b, CASE WHEN x THEN 'PUBLIC' END);"), []);
  assert.deepEqual(literalGrantees('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO "authenticated";'), ["authenticated"]);
  assert.deepEqual(literalGrantees("-- GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;"), [], "a commented-out grant is inert");
  assert.deepEqual(literalOwners("ALTER TABLE public.weekly_reports OWNER TO anon;"), ["anon"]);
  assert.deepEqual(literalOwners("EXECUTE format('ALTER %s %I.%I OWNER TO %I', kind, a, b, owner);"), []);
});

test("a GRANT whose grantee is computed appears only in the reviewed carries of an object's own grants", () => {
  // 000131 and 000132 rebuild a view and re-grant exactly what the old one
  // held, reading its ACL (format('GRANT %s ... TO %s%s', ...)). After 000138
  // nothing of anon's is left to carry, and 000138 replays after both. Any
  // other computed grantee could be anon (format('... TO %I', 'anon')), and
  // the literal scan above cannot see it: review it, then list it here.
  const found = Object.fromEntries(sqlFiles.map((path) => [path, computedGrants(readRepo(path))]).filter(([, n]) => n > 0));
  assert.deepEqual(found, {
    "services/migrations/000131_widen_stock_price_precision.down.sql": 1,
    "services/migrations/000131_widen_stock_price_precision.up.sql": 1,
    "services/migrations/000132_extend_fundamentals.down.sql": 1,
    "services/migrations/000132_extend_fundamentals.up.sql": 1,
  });
  // the matcher itself
  assert.equal(computedGrants("DO $$ BEGIN EXECUTE format('GRANT SELECT ON public.shorts TO %I', 'anon'); END $$;"), 1);
  assert.equal(computedGrants("EXECUTE 'GRANT SELECT ON public.shorts TO ' || quote_ident(r);"), 1);
  assert.equal(computedGrants("GRANT SELECT ON public.shorts TO service_role;"), 0);
  assert.equal(computedGrants("-- EXECUTE format('GRANT SELECT ON t TO %I', r);"), 0);
});

test("no SQL file creates a policy, or forces or disables row level security", () => {
  const offenders = [];
  for (const path of sqlFiles.filter((p) => !READ_ONLY_PROBES.has(p))) {
    const sql = code(readRepo(path));
    if (/\bCREATE\s+POLICY\b/i.test(sql)) offenders.push(`${path}: CREATE POLICY`);
    if (/(?<!\bNO\s)\bFORCE\s+ROW\s+LEVEL\s+SECURITY\b/i.test(sql)) offenders.push(`${path}: FORCE ROW LEVEL SECURITY`);
    if (/\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b/i.test(sql)) offenders.push(`${path}: DISABLE ROW LEVEL SECURITY`);
  }
  assert.deepEqual(
    offenders,
    [],
    "Every table in public has row level security on and no policy, which denies every role that is neither the owner nor BYPASSRLS. A policy is the only way that opens a row to the Data API; FORCE would subject an owner to it. Every .sql file is scanned, the legacy supabase/ and web/supabase/ SQL included.",
  );
  // the read-only probes left out above are the check (whose rls_forced class
  // names FORCE in its message) and the two pre-checks, and nothing else
  assert.ok([...READ_ONLY_PROBES].every((p) => sqlFiles.includes(p)));
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
