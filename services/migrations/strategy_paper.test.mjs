// node --test services/migrations/strategy_paper.test.mjs
//
// 000159 is the paper track's three tables (trades, equity, checkpoints). Prod replays every allowlisted
// migration on every deploy, so the file must be replay-safe, touch no row, grant nothing, define no function,
// and sit in the allowlist after 000158 (the backtest tables) and before the 000138 closer. The paper track's
// container tests (services/jobs/internal/jobs/strategies, the paper_pg tests) run it against a live Postgres.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const up = readFileSync(new URL("./000159_strategy_paper.up.sql", import.meta.url), "utf8");
const down = readFileSync(new URL("./000159_strategy_paper.down.sql", import.meta.url), "utf8");
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

const TABLES = ["strategy_paper_trades", "strategy_paper_equity", "strategy_paper_checkpoints"];

test("the file is one transaction under a short lock timeout, set before the first table", () => {
  assert.match(up, /^BEGIN;/m);
  assert.match(up, /^COMMIT;/m);
  assert.match(up, /SET LOCAL lock_timeout = '15s';/);
  assert.ok(up.indexOf("SET LOCAL lock_timeout") < up.indexOf("CREATE TABLE IF NOT EXISTS strategy_paper_trades"));
});

test("the three tables are created with IF NOT EXISTS and nothing else is a CREATE TABLE", () => {
  const creates = [...code.matchAll(/^CREATE TABLE\b[^\n]*/gim)].map((m) => m[0]);
  assert.equal(creates.length, TABLES.length);
  for (const table of TABLES) {
    assert.ok(
      creates.some((c) => c.includes(`CREATE TABLE IF NOT EXISTS ${table} (`)),
      `${table} is created IF NOT EXISTS`,
    );
  }
});

test("there are no indexes to build: the three tables' keys are their constraints", () => {
  assert.doesNotMatch(code, /\bCREATE (UNIQUE )?INDEX\b/i);
});

test("the trade lifecycle is the status check, and one row per signal per version and recipe", () => {
  assert.match(flat, /status text NOT NULL CHECK \(status IN \('pending_entry','open','pending_exit','closed','cancelled'\)\)/);
  assert.match(flat, /UNIQUE \(rules_hash, recipe_hash, stock_code, signal_date\)/);
});

test("the equity table is keyed by version, recipe and session, and the checkpoint by version and recipe", () => {
  assert.match(flat, /PRIMARY KEY \(rules_hash, recipe_hash, as_of\)/);
  assert.match(flat, /checkpoint jsonb NOT NULL/);
  assert.match(flat, /PRIMARY KEY \(rules_hash, recipe_hash\)/);
});

test("the trades and the checkpoints reference the version and the recipe; the equity table does not", () => {
  assert.match(flat, /rules_hash text NOT NULL REFERENCES strategy_rule_versions\(rules_hash\)/);
  assert.match(flat, /recipe_hash text NOT NULL REFERENCES strategy_recipes\(recipe_hash\)/);
  const equity = flat.slice(flat.indexOf("CREATE TABLE IF NOT EXISTS strategy_paper_equity"));
  assert.doesNotMatch(equity.slice(0, equity.indexOf(");")), /REFERENCES/);
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

test("the down migration drops only the three tables, guarded by IF EXISTS, children first", () => {
  assert.match(down, /^BEGIN;/m);
  assert.match(down, /^COMMIT;/m);
  const drops = [...sqlOnly(down).matchAll(/^DROP [^\n;]*/gim)].map((m) => m[0]);
  assert.deepEqual(drops, [
    "DROP TABLE IF EXISTS strategy_paper_checkpoints",
    "DROP TABLE IF EXISTS strategy_paper_equity",
    "DROP TABLE IF EXISTS strategy_paper_trades",
  ]);
  assert.doesNotMatch(sqlOnly(down), /\bGRANT\b/i);
});

test("the allowlist runs the paper migration after the backtest migration and before the 000138 closer", () => {
  const line = "run_psql_session -f /migrations/000159_strategy_paper.up.sql";
  assert.equal(workflow.split(line).length - 1, 1, "allowlisted once");
  const at = workflow.indexOf(line);
  assert.ok(at > workflow.indexOf("run_psql_session -f /migrations/000158_strategy_backtests.up.sql"), "after 000158");
  assert.ok(at < workflow.indexOf("run_psql_session -f /migrations/000138_harden_data_api_grants.up.sql"), "before the 000138 closer");
});

test("the allowlist comment names the lock, the window and the by-hand command", () => {
  const at = workflow.indexOf("# 000159 (strategy paper track)");
  assert.ok(at > 0, "the comment exists");
  const block = workflow.slice(at, workflow.indexOf("run_psql_session -f /migrations/000159_strategy_paper.up.sql"));
  assert.match(block, /SHARE ROW\s+EXCLUSIVE/);
  assert.match(block, /13:00-16:40 UTC/);
  assert.match(block, /A replay takes no lock/);
  assert.match(block, /task db:prod:apply FILE=services\/migrations\/000159_strategy_paper\.up\.sql CONFIRM=prod/);
});
