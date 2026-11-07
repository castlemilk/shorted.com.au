// node --test services/migrations/strategy_saves.test.mjs
//
// 000157 is the saved-strategies table of the My strategies list. Prod replays every allowlisted
// migration on every deploy, so the file must be replay-safe, touch no row, grant nothing, and sit in
// the allowlist after the strategy capture migration, after 000153 and before the 000138 closer. The store's container test
// (services/shorts/internal/store/shorts, the StrategySaves suite) runs it against a live Postgres.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const up = readFileSync(new URL("./000157_strategy_saves.up.sql", import.meta.url), "utf8");
const down = readFileSync(new URL("./000157_strategy_saves.down.sql", import.meta.url), "utf8");
const workflow = readFileSync(
  new URL("../../.github/workflows/terraform-deploy.yml", import.meta.url),
  "utf8",
);

// SQL with its `--` comments removed, so a rule about statements is not tripped by prose.
function sqlOnly(text) {
  return text
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

const code = sqlOnly(up);
const flat = code.replace(/\s+/g, " ");

test("the file is one transaction under a short lock timeout", () => {
  assert.match(up, /^BEGIN;/m);
  assert.match(up, /^COMMIT;/m);
  assert.match(up, /SET LOCAL lock_timeout = '5s';/);
  assert.ok(up.indexOf("SET LOCAL lock_timeout") < up.indexOf("CREATE TABLE IF NOT EXISTS user_saved_strategies"));
});

test("the one table is replay-safe and keyed by user and strategy reference", () => {
  const creates = [...code.matchAll(/^CREATE TABLE\b[^\n]*/gim)].map((m) => m[0]);
  assert.equal(creates.length, 1);
  assert.match(creates[0], /IF NOT EXISTS/i);
  assert.match(flat, /CREATE TABLE IF NOT EXISTS user_saved_strategies \(/);
  assert.match(flat, /user_id TEXT NOT NULL/);
  assert.match(flat, /created_at TIMESTAMPTZ NOT NULL DEFAULT now\(\)/);
  assert.match(flat, /PRIMARY KEY \(user_id, strategy_ref\)/);
});

test("the reference admits a canonical id or a variant id, and nothing else", () => {
  assert.match(flat, /CHECK \(strategy_ref ~ '\^\(\[a-z0-9-\]\{1,64\}\|variant:\[A-Za-z0-9-\]\{1,64\}\)\$'\)/);
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
    /\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bTRUNCATE\b/i,
    /\bCREATE (UNIQUE )?INDEX\b/i,
  ]) {
    assert.doesNotMatch(code, pattern, `must not match ${pattern}`);
  }
});

test("the down migration drops only the table, guarded by IF EXISTS", () => {
  assert.match(down, /^BEGIN;/m);
  assert.match(down, /^COMMIT;/m);
  const drops = [...sqlOnly(down).matchAll(/^DROP [^\n;]*/gim)].map((m) => m[0]);
  assert.deepEqual(drops, ["DROP TABLE IF EXISTS user_saved_strategies"]);
  assert.doesNotMatch(sqlOnly(down), /\bGRANT\b/i);
});

test("the allowlist runs the saved-strategies migration after the strategy capture, after 000153 and before the 000138 closer", () => {
  const line = "run_psql_session -f /migrations/000157_strategy_saves.up.sql";
  assert.equal(workflow.split(line).length - 1, 1, "allowlisted once");
  const at = workflow.indexOf(line);
  const capture = workflow.match(/run_psql_session -f \/migrations\/0001\d\d_strategy_capture\.up\.sql/);
  assert.ok(capture, "the strategy capture migration is allowlisted");
  assert.ok(at > workflow.indexOf(capture[0]), "after the strategy capture");
  assert.ok(at > workflow.indexOf("run_psql_session -f /migrations/000153_add_crawl_ops_indexes.up.sql"), "after 000153");
  assert.ok(at < workflow.indexOf("run_psql_session -f /migrations/000138_harden_data_api_grants.up.sql"), "before the 000138 closer");
});
