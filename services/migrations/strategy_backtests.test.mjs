// node --test services/migrations/strategy_backtests.test.mjs
//
// 000158 is the backtest job's four tables (runs, series, trades, requests). Prod replays every allowlisted
// migration on every deploy, so the file must be replay-safe, touch no row, grant nothing, define no function,
// and sit in the allowlist after 000157 (the saved-strategies table) and before the 000138 closer. The job's
// container tests (services/jobs/internal/jobs/strategies, the Backtest tests) run it against a live Postgres.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const up = readFileSync(new URL("./000158_strategy_backtests.up.sql", import.meta.url), "utf8");
const down = readFileSync(new URL("./000158_strategy_backtests.down.sql", import.meta.url), "utf8");
const workflow = readFileSync(new URL("../../.github/workflows/terraform-deploy.yml", import.meta.url), "utf8");

// SQL with its `--` comments removed, so a rule about statements is not tripped by prose.
function sqlOnly(text) {
  return text
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

const code = sqlOnly(up);
const flat = code.replace(/\s+/g, " ");

const TABLES = [
  "strategy_backtest_runs",
  "strategy_backtest_series",
  "strategy_backtest_trades",
  "strategy_backtest_requests",
];

test("the file is one transaction under a short lock timeout, set before the first table", () => {
  assert.match(up, /^BEGIN;/m);
  assert.match(up, /^COMMIT;/m);
  assert.match(up, /SET LOCAL lock_timeout = '15s';/);
  assert.ok(up.indexOf("SET LOCAL lock_timeout") < up.indexOf("CREATE TABLE IF NOT EXISTS strategy_backtest_runs"));
});

test("the four tables are created with IF NOT EXISTS and nothing else is a CREATE TABLE", () => {
  const creates = [...code.matchAll(/^CREATE TABLE\b[^\n]*/gim)].map((m) => m[0]);
  assert.equal(creates.length, TABLES.length);
  for (const table of TABLES) {
    assert.ok(
      creates.some((c) => c.includes(`CREATE TABLE IF NOT EXISTS ${table} (`)),
      `${table} is created IF NOT EXISTS`,
    );
  }
});

test("every index is created only inside a catalog-guarded DO block", () => {
  const indexes = [...code.matchAll(/CREATE (UNIQUE )?INDEX\b[^;]*/gi)].map((m) => m[0]);
  assert.ok(indexes.length >= 6, "the indexes exist");
  const guards = [...flat.matchAll(/IF to_regclass\('public\.(\w+)'\) IS NULL THEN/g)].map((m) => m[1]);
  for (const name of [
    "idx_sbr_published",
    "idx_sbr_run_key",
    "idx_sbr_variant",
    "idx_sbt_run_code",
    "idx_sbq_queue",
    "idx_sbq_user",
  ]) {
    assert.ok(guards.includes(name), `${name} is guarded by to_regclass`);
  }
  // A CREATE INDEX outside a DO block would be unguarded. Each one sits between a guard and its END.
  const bodies = [...flat.matchAll(/IF to_regclass\('public\.\w+'\) IS NULL THEN (.*?) END IF;/g)].map((m) => m[1]);
  assert.equal(bodies.length, indexes.length, "one guard per index");
});

test("the published-run index keeps one published run per key and the run key is unique among succeeded runs", () => {
  assert.match(flat, /CREATE UNIQUE INDEX idx_sbr_published ON strategy_backtest_runs \(strategy_id, rules_hash, recipe_hash, fundamentals\) WHERE published/);
  assert.match(flat, /CREATE UNIQUE INDEX idx_sbr_run_key ON strategy_backtest_runs \(run_key\) WHERE status = 'succeeded' AND kind <> 'verify'/);
});

test("the request queue dedupes on its key and the trade table is keyed by run and sequence", () => {
  assert.match(flat, /dedupe_key text NOT NULL UNIQUE/);
  assert.match(flat, /PRIMARY KEY \(run_id, seq\)/);
  assert.match(flat, /CHECK \(kind IN \('publish','variant','verify'\)\)/);
});

test("nothing grants, owns, polices, secures or defines a function, and nothing touches a row", () => {
  for (const pattern of [
    /\bGRANT\b/i,
    /\bREVOKE\b/i,
    /\bOWNER TO\b/i,
    /\bCREATE POLICY\b/i,
    /\bROW LEVEL SECURITY\b/i,
    /\bFORCE\b/i,
    /\bSECURITY DEFINER\b/i,
    /\bCREATE (OR REPLACE )?FUNCTION\b/i,
    /\banon\b|\bauthenticated\b|\bPUBLIC\b/,
    /\bINSERT INTO\b|\bUPDATE \w+ SET\b|\bDELETE FROM\b|\bTRUNCATE\b/i,
  ]) {
    assert.doesNotMatch(code, pattern, `must not match ${pattern}`);
  }
});

test("the down migration drops only the four tables, guarded by IF EXISTS, children first", () => {
  assert.match(down, /^BEGIN;/m);
  assert.match(down, /^COMMIT;/m);
  const drops = [...sqlOnly(down).matchAll(/^DROP [^\n;]*/gim)].map((m) => m[0]);
  assert.deepEqual(drops, [
    "DROP TABLE IF EXISTS strategy_backtest_trades",
    "DROP TABLE IF EXISTS strategy_backtest_series",
    "DROP TABLE IF EXISTS strategy_backtest_runs",
    "DROP TABLE IF EXISTS strategy_backtest_requests",
  ]);
  assert.doesNotMatch(sqlOnly(down), /\bGRANT\b/i);
});

test("the allowlist runs the backtest migration after the saved-strategies migration and before the 000138 closer", () => {
  const line = "run_psql_session -f /migrations/000158_strategy_backtests.up.sql";
  assert.equal(workflow.split(line).length - 1, 1, "allowlisted once");
  const at = workflow.indexOf(line);
  const saves = workflow.match(/run_psql_session -f \/migrations\/000157_strategy_saves\.up\.sql/);
  assert.ok(saves, "the saved-strategies migration is allowlisted");
  assert.ok(at > workflow.indexOf(saves[0]), "after 000157");
  assert.ok(at < workflow.indexOf("run_psql_session -f /migrations/000138_harden_data_api_grants.up.sql"), "before the 000138 closer");
});
