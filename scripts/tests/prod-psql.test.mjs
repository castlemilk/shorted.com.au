// Behaviour of scripts/prod-psql.sh, the wrapper every db:prod:* task runs,
// and of scripts/prod-psql-classify.mjs, which decides how a file may run.
//
// The guards it replaces were PGOPTIONS, which Supabase's pooler silently drops:
// the read-only prod shell could write, and migrations and MV refreshes ran
// under a 2-minute statement timeout while looking like they had none. Nothing
// failed at runtime, so these tests are the only thing that notices a guard
// going missing.
//
// The guards are also TRANSACTION-scoped (SET LOCAL inside one transaction).
// Whether Supavisor's session pooler resets a session-level SET before it hands
// the backend to the next client is unverified, so nothing here may depend on
// it; the one session-level fallback is pinned below with its RESET ALL.
//
// Most tests shim `psql` on PATH and record its argv. psql runs -c/-f in
// argument order in one session, so argv order IS the order Postgres sees the
// SETs, the checks and the work. The last test drives a real Postgres, and only
// when PROD_PSQL_LIVE_DSN names a scratch database (never prod); CI has none,
// so it skips there.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { classify, splitStatements } from "../prod-psql-classify.mjs";

const script = new URL("../prod-psql.sh", import.meta.url).pathname;
const rcFile = new URL("../prod-psql-read-only.psqlrc", import.meta.url).pathname;
const migrationsDir = new URL("../../services/migrations/", import.meta.url).pathname;
const SESSION_DSN = "postgresql://u:p@pooler.example:5432/postgres";

// A psql stand-in. It answers --version, appends one JSON record per real call
// ({ argv, psqlrc }), writes SHIM_STDERR to stderr and exits SHIM_EXIT.
function makeShim(dir, log) {
  writeFileSync(
    join(dir, "psql"),
    `#!/usr/bin/env node
const fs = require("fs");
const argv = process.argv.slice(2);
if (argv[0] === "--version") {
  console.log("psql (PostgreSQL) " + (process.env.SHIM_VERSION || "17.6"));
  process.exit(0);
}
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, psqlrc: process.env.PSQLRC || null }) + "\\n");
if (process.env.SHIM_STDERR) process.stderr.write(process.env.SHIM_STDERR);
process.exit(Number(process.env.SHIM_EXIT || 0));
`,
  );
  chmodSync(join(dir, "psql"), 0o755);
}

function readCalls(log) {
  try {
    return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return []; // psql never called
  }
}

/** Run the wrapper against the shim. `tty` runs it under script(1) for a real terminal. */
function run(args, { pgurl = SESSION_DSN, env: extra = {}, tty = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "prod-psql-"));
  const log = join(dir, "calls.jsonl");
  makeShim(dir, log);
  const base = { ...process.env };
  delete base.PGURL;
  delete base.PGPORT;
  const env = { ...base, PATH: `${dir}:${process.env.PATH}`, ...extra };
  if (pgurl !== null) env.PGURL = pgurl;
  try {
    let res;
    if (tty) {
      // script(1) gives the wrapper a pseudo-terminal. It needs its own stdin
      // to be a terminal or nothing (a pipe makes it fail on tcgetattr).
      const cmd = ["bash", script, ...args];
      const opts = { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] };
      res =
        process.platform === "darwin"
          ? spawnSync("script", ["-q", "/dev/null", ...cmd], opts)
          : spawnSync("script", ["-qec", cmd.join(" "), "/dev/null"], opts);
    } else {
      res = spawnSync("bash", [script, ...args], { env, encoding: "utf8" });
    }
    return { status: res.status, stdout: res.stdout, stderr: res.stderr, calls: readCalls(log) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Index of the first argv entry that contains `needle`, asserting it exists. */
function at(argv, needle) {
  const i = argv.findIndex((a) => a.includes(needle));
  assert.notEqual(i, -1, `expected an argument containing ${JSON.stringify(needle)} in ${JSON.stringify(argv)}`);
  return i;
}

/** No argument may carry a session-level SET (a SET that is not SET LOCAL). */
function assertNoSessionSet(argv) {
  for (const a of argv) {
    assert.doesNotMatch(a, /(^|;\s*|\n)\s*SET\s+(?!LOCAL\b)/i, `session-level SET in ${JSON.stringify(a)}`);
  }
}

function tempSql(sql) {
  const dir = mkdtempSync(join(tmpdir(), "prod-psql-sql-"));
  const file = join(dir, "000999_test.up.sql");
  writeFileSync(file, sql);
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// Refusals that happen before psql runs at all.

test("the transaction pooler is refused before psql runs", () => {
  for (const pgurl of [
    "postgresql://u:p@pooler.example:6543/postgres",
    "postgresql://u:p@pooler.example:6543/postgres?sslmode=require",
    "host=pooler.example port=6543 dbname=postgres",
  ]) {
    const { status, stderr, calls } = run(["read-only", "-c", "SELECT 1"], { pgurl });
    assert.equal(status, 2, stderr);
    assert.match(stderr, /refusing the transaction pooler/);
    assert.deepEqual(calls, [], "psql must not be invoked against 6543");
  }
  const viaEnv = run(["read-only", "-c", "SELECT 1"], { pgurl: "postgresql://u:p@pooler.example/postgres", env: { PGPORT: "6543" } });
  assert.equal(viaEnv.status, 2);
  assert.deepEqual(viaEnv.calls, []);
});

test("a missing DSN is refused rather than falling back to libpq defaults", () => {
  const { status, stderr, calls } = run(["read-only", "-c", "SELECT 1"], { pgurl: null });
  assert.equal(status, 2);
  assert.match(stderr, /PGURL is not set/);
  assert.deepEqual(calls, []);
});

test("psql older than 15 is refused: --single-transaction would not wrap the -c guards", () => {
  const { status, stderr, calls } = run(["refresh", "refresh_housing_materialized_views"], {
    env: { SHIM_VERSION: "14.11" },
  });
  assert.equal(status, 2);
  assert.match(stderr, /psql 15 or newer/);
  assert.deepEqual(calls, []);
});

// ---------------------------------------------------------------------------
// read-only

test("a scripted probe is ONE -c string: BEGIN READ ONLY, SET LOCALs, check, SQL, ROLLBACK", () => {
  const { status, stderr, calls } = run(["read-only", "-At", "-c", "SELECT count(*) FROM property_price_events"]);
  assert.equal(status, 0, stderr);
  assert.equal(calls.length, 1);
  const { argv } = calls[0];

  assert.ok(argv.includes("-X"), "the operator's ~/.psqlrc must not shape a prod session");
  assert.ok(argv.includes("-At"), "output flags pass through");
  assert.deepEqual(argv.slice(argv.indexOf("-v"), argv.indexOf("-v") + 2), ["-v", "ON_ERROR_STOP=1"]);
  assert.equal(argv.filter((a) => a === "-c").length, 1, "one -c: separate -c flags are separate implicit transactions");

  const body = argv[argv.indexOf("-c") + 1];
  const order = [
    "BEGIN READ ONLY;",
    "SET LOCAL default_transaction_read_only = on;",
    "SET LOCAL statement_timeout = '60s';",
    "guard not in effect: transaction_read_only",
    "guard not in effect: statement_timeout",
    "SELECT count(*) FROM property_price_events",
  ];
  let last = -1;
  for (const needle of order) {
    const i = body.indexOf(needle);
    assert.ok(i > last, `${JSON.stringify(needle)} out of order in:\n${body}`);
    last = i;
  }
  assert.match(body, /ROLLBACK;$/, "the probe must end by rolling back");
  assert.ok(body.startsWith("BEGIN READ ONLY;"), "nothing may run before the transaction opens");
  assertNoSessionSet(argv);
});

test("the probe timeout is configurable, but only as a plain duration", () => {
  const ok = run(["read-only", "-c", "SELECT 1"], { env: { PROD_PSQL_READ_TIMEOUT: "5min" } });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.calls[0].argv.join("\n"), /SET LOCAL statement_timeout = '5min';/);

  const day = run(["read-only", "-c", "SELECT 1"], { env: { PROD_PSQL_READ_TIMEOUT: "1440min" } });
  assert.equal(day.status, 0, day.stderr);

  // Past 24h is refused here: the server rejects a statement_timeout beyond its
  // int range, and in the interactive shell a failed SET is a guard that did
  // not take effect.
  for (const bad of ["0", "1min'; COMMIT; --", "forever", "1441min", "86400001ms", "999999999min", "999999999999999999999s"]) {
    const res = run(["read-only", "-c", "SELECT 1"], { env: { PROD_PSQL_READ_TIMEOUT: bad } });
    assert.equal(res.status, 2, `accepted ${JSON.stringify(bad)}`);
    assert.deepEqual(res.calls, []);
  }
});

test("a probe that would end its own transaction is refused", () => {
  // In one -c string, a COMMIT ends the READ ONLY transaction and whatever
  // follows runs in a fresh, writable one.
  for (const sql of ["SELECT 1; COMMIT; DELETE FROM x", "ROLLBACK; UPDATE x SET y = 1", "end; truncate x", "VACUUM x"]) {
    const { status, stderr, calls } = run(["read-only", "-c", sql]);
    assert.equal(status, 2, `accepted ${JSON.stringify(sql)}`);
    assert.match(stderr, /refusing this probe/);
    assert.deepEqual(calls, []);
  }
});

test("a probe cannot hide a COMMIT by making the screen and the server lex it differently", () => {
  // Each of these got a CREATE TABLE committed on a scratch PG 17 through the
  // old screen: the screen thought the COMMIT was inside a quote, a comment or
  // one statement, and the server did not.
  const tail = "; COMMIT; CREATE TABLE evil (x int); COMMIT; ";
  const probes = {
    "`$` inside an identifier (x$$$ is one identifier)": `SELECT 1 AS x$$$${tail}SELECT 'a$$'`,
    "a non-ASCII identifier before $$": `SELECT 1 AS é$$${tail}SELECT 'a$$'`,
    "a non-ASCII dollar-quote tag": `SELECT $é$ $$ $é$${tail}SELECT $$x$$`,
    "a line comment ended by a bare CR": `SELECT 1 --x\r${tail}\n`,
    "`begin atomic` as a column and an alias": `SELECT begin atomic FROM (SELECT 1 AS begin) s${tail}SELECT 1 AS end`,
    "a number, then a dollar quote": `SELECT 1$$ $$${tail}SELECT $$x$$`,
    "a parameter, then a dollar quote": `SELECT $1$$ $$${tail}SELECT $$x$$`,
    // With standard_conforming_strings off, \' does not end '...'.
    "a backslash before a quote in a plain string": `SELECT '\\' '${tail}SELECT 'x'`,
  };
  for (const [what, sql] of Object.entries(probes)) {
    assert.equal(classify(sql, { probe: true }).verdict, "refuse", what);
  }
  // Still lexed as the server lexes them, so ordinary probes pass.
  for (const sql of [
    "SELECT x$y, $$a;COMMIT$$, $t$;$t$, E'\\\\'';COMMIT', 'C:\\\\' FROM t",
    "SELECT 1 -- COMMIT; trailing\nFROM t",
    "SELECT 1e5, .5, 0x1F, $1 FROM t WHERE c ~ '\\d+'",
  ]) {
    assert.equal(classify(sql, { probe: true }).verdict, "transaction", sql);
  }
  // A real BEGIN ATOMIC body still counts as one statement when applying.
  assert.equal(
    splitStatements("CREATE OR REPLACE FUNCTION g() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; END;").length,
    1,
  );
});

test("a probe takes only SQL and output flags", () => {
  for (const args of [["-1", "-c", "SELECT 1"], ["-v", "AUTOCOMMIT=off", "-c", "SELECT 1"], ["-d", "other", "-c", "SELECT 1"]]) {
    const { status, calls } = run(["read-only", ...args]);
    assert.equal(status, 2, `accepted ${JSON.stringify(args)}`);
    assert.deepEqual(calls, []);
  }
});

test("the interactive shell loads the read-only rc file, with its timeout, and nothing else", () => {
  const { status, stdout, stderr, calls } = run(["read-only"], { tty: true });
  assert.equal(status, 0, stdout + stderr);
  assert.equal(calls.length, 1);
  const [{ argv, psqlrc }] = calls;
  assert.equal(psqlrc, rcFile, "the shell must load the read-only startup file");
  assert.ok(!argv.includes("-X"), "-X would skip the startup file that opens the READ ONLY transaction");
  assert.ok(argv.includes("prod_timeout=60s"), JSON.stringify(argv));
  // In a startup file ON_ERROR_STOP ends the FILE at a failed SET, skipping the
  // check and the kill, and psql opens the shell anyway.
  assert.ok(!argv.some((a) => /ON_ERROR_STOP/.test(a)), JSON.stringify(argv));
  assertNoSessionSet(argv);
});

test("without a terminal, an argument-less read-only call is refused rather than reading SQL from stdin", () => {
  const { status, stderr, calls } = run(["read-only"]);
  assert.equal(status, 2);
  assert.match(stderr, /not a terminal/);
  assert.deepEqual(calls, []);
});

test("the read-only rc file opens ONE read-only transaction, checks it, and kills psql if it fails", () => {
  const rc = readFileSync(rcFile, "utf8");
  const lines = rc.split("\n").filter((l) => l.trim() && !l.trim().startsWith("--"));

  // No session-level SET anywhere: the shell must leave nothing on the backend.
  for (const l of lines) assert.doesNotMatch(l, /^\s*SET\s+(?!LOCAL\b)/i, `session-level SET: ${l}`);

  const idx = (re) => lines.findIndex((l) => re.test(l));
  const stopOff = idx(/^\\set ON_ERROR_STOP off$/);
  const rollbackOff = idx(/^\\set ON_ERROR_ROLLBACK off$/);
  const begin = idx(/^BEGIN READ ONLY;/);
  const setRo = idx(/^SET LOCAL default_transaction_read_only = on;/);
  const setTimeout = idx(/^SET LOCAL statement_timeout = :'prod_timeout';/);
  const gset = idx(/\\gset$/);
  const ifGuard = idx(/^\\if :prod_guarded/);
  const errRollback = idx(/^\\set ON_ERROR_ROLLBACK on/);
  const kill = idx(/^\\! kill -TERM \$PPID/);
  const elseBranch = idx(/^\\else/);
  for (const [name, i] of Object.entries({ stopOff, rollbackOff, begin, setRo, setTimeout, gset, ifGuard, errRollback, kill, elseBranch })) {
    assert.notEqual(i, -1, `rc file lost ${name}`);
  }
  // Whatever -v or the system psqlrc set, a failed statement must fall through
  // to the check and the kill, not end the file (ON_ERROR_STOP) or be rolled
  // back to a savepoint and ignored (ON_ERROR_ROLLBACK).
  assert.ok(stopOff < begin && rollbackOff < begin, "error handling forced off before the guard runs");
  assert.ok(begin < setRo && setRo < setTimeout && setTimeout < gset && gset < ifGuard, "BEGIN, SETs, check, then branch");
  // Set before the check, ON_ERROR_ROLLBACK would roll a failed SET back to a
  // savepoint and the shell would open without it.
  assert.ok(ifGuard < errRollback && errRollback < elseBranch, "ON_ERROR_ROLLBACK only once the guard holds");
  // \q in a startup file ends only the file; psql then reads the terminal.
  assert.ok(elseBranch < kill, "the failure branch must terminate psql");
  assert.match(rc, /AS prod_guarded \\gset/);
  assert.match(rc, /current_setting\('transaction_read_only'\) = 'on'/);
});

// ---------------------------------------------------------------------------
// apply

test("apply wraps an ordinary migration in ONE transaction with SET LOCAL statement_timeout = 0", () => {
  const file = join(migrationsDir, "000107_harden_housing_mv_refresh.up.sql");
  const { status, stderr, calls } = run(["apply", file]);
  assert.equal(status, 0, stderr);
  assert.equal(calls.length, 1);
  const { argv } = calls[0];

  assert.ok(argv.includes("-X"));
  assert.ok(argv.includes("--single-transaction"), "the guard must be transaction-scoped");
  const set = argv.indexOf("SET LOCAL statement_timeout = 0");
  const check = at(argv, "guard not in effect: statement_timeout");
  const fileArg = argv.indexOf(file);
  const reset = argv.indexOf("RESET ALL");
  assert.equal(argv[set - 1], "-c");
  assert.equal(argv[fileArg - 1], "-f");
  assert.ok(set !== -1 && set < check && check < fileArg && fileArg < reset, `SET LOCAL, check, -f, RESET ALL; got ${JSON.stringify(argv)}`);
  assert.equal(reset, argv.length - 1, "RESET ALL is the last thing inside the transaction");
  assertNoSessionSet(argv);
  assert.doesNotMatch(stderr, /WARNING/);
});

test("apply falls back to a session SET only for a statement that cannot run in a transaction, and warns", () => {
  const { file, cleanup } = tempSql("CREATE TABLE t (x int);\nCREATE INDEX CONCURRENTLY t_x ON t (x);\n");
  try {
    const { status, stderr, calls } = run(["apply", file]);
    assert.equal(status, 0, stderr);
    assert.match(stderr, /WARNING: CREATE INDEX CONCURRENTLY cannot run inside a transaction block/);
    assert.match(stderr, /SESSION-level SET statement_timeout = 0, undone by RESET ALL/);
    const { argv } = calls[0];
    assert.ok(!argv.includes("--single-transaction"), "CREATE INDEX CONCURRENTLY fails inside one");
    const set = argv.indexOf("SET statement_timeout = 0");
    const check = at(argv, "guard not in effect: statement_timeout");
    const fileArg = argv.indexOf(file);
    const reset = argv.indexOf("RESET ALL");
    assert.ok(set !== -1 && set < check && check < fileArg && fileArg < reset, JSON.stringify(argv));
    assert.equal(reset, argv.length - 1, "RESET ALL must be the last command sent");
  } finally {
    cleanup();
  }
});

test("when the session fallback stops early, the wrapper says the SET may have been left behind", () => {
  const { file, cleanup } = tempSql("VACUUM t;\n");
  try {
    const { status, stderr } = run(["apply", file], { env: { SHIM_EXIT: "3" } });
    assert.equal(status, 3);
    assert.match(stderr, /stopped \(exit 3\) before RESET ALL ran/);
  } finally {
    cleanup();
  }
});

test("apply refuses a missing file and a file with psql meta-commands", () => {
  const missing = run(["apply", "/nonexistent/000999_nope.up.sql"]);
  assert.equal(missing.status, 2);
  assert.deepEqual(missing.calls, []);

  const { file, cleanup } = tempSql("SELECT 1;\n\\connect other\nDROP TABLE t;\n");
  try {
    const meta = run(["apply", file]);
    assert.equal(meta.status, 2);
    assert.match(meta.stderr, /meta-command/);
    assert.deepEqual(meta.calls, []);
  } finally {
    cleanup();
  }
});

test("no migration in the repo is refused by apply", () => {
  for (const f of readdirSync(migrationsDir).filter((f) => f.endsWith(".up.sql"))) {
    const { verdict, reason } = classify(readFileSync(join(migrationsDir, f), "utf8"));
    assert.notEqual(verdict, "refuse", `${f}: ${reason}`);
  }
});

// ---------------------------------------------------------------------------
// refresh

test("refresh runs the call in ONE transaction with SET LOCAL statement_timeout = 0 first", () => {
  // The function's own `SET statement_timeout` (000107) cannot disarm the
  // timer Postgres started for the calling statement, so the override has to
  // come before the call.
  const { status, stderr, calls } = run(["refresh", "refresh_housing_materialized_views"]);
  assert.equal(status, 0, stderr);
  const { argv } = calls[0];
  assert.ok(argv.includes("--single-transaction"));
  const set = argv.indexOf("SET LOCAL statement_timeout = 0");
  const check = at(argv, "guard not in effect: statement_timeout");
  const call = argv.indexOf("SELECT refresh_housing_materialized_views()");
  assert.ok(set !== -1 && set < check && check < call, JSON.stringify(argv));
  assertNoSessionSet(argv);
});

test("refresh fails when the function reports a skipped view", () => {
  // The refresh functions turn a failed view into RAISE WARNING 'Skipping …'
  // and return normally. psql exits 0; the wrapper must not.
  const { status, stderr } = run(["refresh", "refresh_housing_materialized_views"], {
    env: { SHIM_STDERR: "WARNING:  Failed to refresh mv_a concurrently: x. Trying non-concurrent...\nWARNING:  Skipping mv_suburb_price_drops: canceling statement due to statement timeout\n" },
  });
  assert.equal(status, 1);
  assert.match(stderr, /skipped 1 view\(s\)/);

  const fallbackOnly = run(["refresh", "refresh_housing_materialized_views"], {
    env: { SHIM_STDERR: "WARNING:  Failed to refresh mv_a concurrently: x. Trying non-concurrent...\n" },
  });
  assert.equal(fallbackOnly.status, 0, "a non-concurrent fallback still refreshed the view");
});

test("refresh only interpolates a bare identifier", () => {
  for (const fn of ["x(); DROP TABLE y", "public.refresh_all", "Refresh", ""]) {
    const { status, calls } = run(["refresh", fn]);
    assert.equal(status, 2, `accepted ${JSON.stringify(fn)}`);
    assert.deepEqual(calls, []);
  }
});

// ---------------------------------------------------------------------------
// The classifier

test("the splitter ignores semicolons and keywords inside comments, strings and function bodies", () => {
  const sql = `
    -- COMMIT; in a comment
    /* nested /* COMMIT; */ still comment */
    CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $fn$
    BEGIN
      COMMIT; -- inside the body
    END $fn$;
    SELECT 'it''s; COMMIT', E'\\'; COMMIT', "odd;name", $$;$$;
    CREATE FUNCTION g() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; SELECT 2; END;
  `;
  const stmts = splitStatements(sql);
  assert.equal(stmts.length, 3, JSON.stringify(stmts));
  assert.equal(classify(sql).verdict, "transaction");
});

test("the classifier tells a wrapped file from one that commits partway", () => {
  assert.equal(classify("BEGIN;\nCREATE TABLE a (x int);\nCOMMIT;\n").verdict, "transaction");
  assert.equal(classify("CREATE TABLE a (x int);\nSAVEPOINT s;\nROLLBACK TO SAVEPOINT s;\n").verdict, "transaction");
  const partway = classify("BEGIN;\nCREATE TABLE a (x int);\nCOMMIT;\nCREATE TABLE b (x int);\n");
  assert.equal(partway.verdict, "session", "our SET LOCAL would end at the file's COMMIT");
  assert.equal(classify("ALTER TYPE t ADD VALUE 'x';\n").verdict, "session");
  assert.equal(classify("DROP INDEX CONCURRENTLY i;\n").verdict, "session");
  assert.equal(classify("-- nothing\n").verdict, "refuse");
});

// ---------------------------------------------------------------------------
// A real Postgres, to show the mechanism rather than the argv. Set
// PROD_PSQL_LIVE_DSN to a SCRATCH database on a local server. The test arms a
// 300ms baseline timeout through PGOPTIONS, which plain Postgres honours, to
// stand in for Supabase's 2-minute role default. It creates and drops its own
// objects.
test(
  "against a real Postgres: the SETs beat an armed baseline, and read-only holds",
  { skip: !process.env.PROD_PSQL_LIVE_DSN },
  () => {
    const dsn = process.env.PROD_PSQL_LIVE_DSN;
    assert.doesNotMatch(dsn, /supabase|pooler/i, "PROD_PSQL_LIVE_DSN must be a local scratch database");
    const env = { ...process.env, PGURL: dsn, PGOPTIONS: "-c statement_timeout=300ms" };
    delete env.PGPORT;
    const psql = (args, extra = {}) => spawnSync("psql", [dsn, "-X", ...args], { env: { ...env, ...extra }, encoding: "utf8" });
    const wrapper = (args, opts = {}) => spawnSync("bash", [script, ...args], { env, encoding: "utf8", ...opts });
    const dir = mkdtempSync(join(tmpdir(), "prod-psql-live-"));
    try {
      psql(["-q", "-c", "DROP TABLE IF EXISTS prod_psql_live_a, prod_psql_live_b"]);
      const slow = join(dir, "slow.sql");
      writeFileSync(slow, "SELECT pg_sleep(0.6);\nCREATE TABLE prod_psql_live_a (x int);\n");
      const concurrent = join(dir, "concurrent.sql");
      writeFileSync(
        concurrent,
        "CREATE TABLE prod_psql_live_b (x int);\nSELECT pg_sleep(0.6);\nCREATE INDEX CONCURRENTLY prod_psql_live_b_x ON prod_psql_live_b (x);\n",
      );

      const control = psql(["-v", "ON_ERROR_STOP=1", "-f", slow]);
      assert.notEqual(control.status, 0, "control: the armed baseline must cancel a bare psql");
      assert.match(control.stderr, /statement timeout/);

      const apply = wrapper(["apply", slow]);
      assert.equal(apply.status, 0, apply.stderr);
      assert.match(apply.stderr, /statement_timeout=0/);

      const fallback = wrapper(["apply", concurrent]);
      assert.equal(fallback.status, 0, fallback.stderr);
      assert.match(fallback.stderr, /SESSION-level SET/);

      const tables = psql(["-At", "-c", "SELECT count(*) FROM pg_class WHERE relname IN ('prod_psql_live_a','prod_psql_live_b','prod_psql_live_b_x')"]);
      assert.equal(tables.stdout.trim(), "3");

      const show = wrapper(["read-only", "-At", "-c", "SHOW default_transaction_read_only", "-c", "SHOW statement_timeout"]);
      assert.equal(show.status, 0, show.stderr);
      assert.deepEqual(show.stdout.trim().split("\n"), ["on", "1min"]);

      const write = wrapper(["read-only", "-c", "CREATE TABLE prod_psql_live_c (x int)"]);
      assert.notEqual(write.status, 0);
      assert.match(write.stderr, /read-only transaction/);

      // The rc file, fed from stdin (psql reads it the same way with a terminal).
      const shell = spawnSync("psql", [dsn, "-v", "ON_ERROR_STOP=1", "-v", "prod_timeout=45s"], {
        env: { ...env, PSQLRC: rcFile },
        input: "SELECT current_setting('transaction_read_only') || '/' || current_setting('statement_timeout') AS s;\n",
        encoding: "utf8",
      });
      assert.match(shell.stdout, /on\/45s/, shell.stderr);
      const broken = spawnSync("psql", [dsn, "-v", "prod_timeout=bogus"], {
        env: { ...env, PSQLRC: rcFile },
        input: "SELECT 'ran after a failed guard' AS s;\n",
        encoding: "utf8",
      });
      assert.doesNotMatch(broken.stdout, /ran after a failed guard/);
      assert.match(broken.stderr, /did NOT take effect/);
      assert.notEqual(broken.status, 0);
      // A guard STATEMENT that errors, with ON_ERROR_STOP on as a caller might
      // pass it: the out-of-range SET used to end the rc file before the check,
      // and psql went on to read input on an unguarded connection.
      const errored = spawnSync("psql", [dsn, "-v", "ON_ERROR_STOP=1", "-v", "prod_timeout=999999999min"], {
        env: { ...env, PSQLRC: rcFile },
        input: "ROLLBACK;\nSELECT 'ran after a failed guard ' || current_setting('transaction_read_only') AS s;\n",
        encoding: "utf8",
      });
      assert.match(errored.stderr, /exceeds integer range/);
      assert.doesNotMatch(errored.stdout, /ran after a failed guard/);
      assert.match(errored.stderr, /did NOT take effect/);
      assert.notEqual(errored.status, 0);
    } finally {
      psql(["-q", "-c", "DROP TABLE IF EXISTS prod_psql_live_a, prod_psql_live_b"]);
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
