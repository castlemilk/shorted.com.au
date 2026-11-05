// node --test services/migrations/strategy_engine.test.mjs
//
// 000156 is the strategy engine's daily snapshot. Prod replays every allowlisted migration on every
// deploy, so the file must be replay-safe, grant nothing, guard every index, and sit in the allowlist
// after the strategy capture and 000153, and before the 000138 closer. The container suite in services/jobs/internal/jobs/strategies
// applies it to a live Postgres.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const up = readFileSync(new URL("./000156_strategy_engine.up.sql", import.meta.url), "utf8");
const down = readFileSync(new URL("./000156_strategy_engine.down.sql", import.meta.url), "utf8");
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
  assert.match(up, /SET LOCAL lock_timeout = '15s';/);
  assert.ok(up.indexOf("SET LOCAL lock_timeout") < up.indexOf("CREATE TABLE IF NOT EXISTS strategy_rule_versions"));
});

test("every table is created replay-safe, and the seven snapshot tables exist", () => {
  const creates = [...code.matchAll(/^CREATE TABLE\b[^\n]*/gim)].map((m) => m[0]);
  assert.equal(creates.length, 7);
  for (const statement of creates) {
    assert.match(statement, /IF NOT EXISTS/i, `not replay-safe: ${statement}`);
  }
  for (const name of [
    "strategy_rule_versions",
    "strategy_recipes",
    "strategy_daily_runs",
    "strategy_regime_daily",
    "strategy_fundamentals_blobs",
    "strategy_features_daily",
    "strategy_signal_events",
  ]) {
    assert.match(code, new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\(`));
  }
});

test("the daily run phases and statuses are the closed sets the job writes", () => {
  assert.match(flat, /phase text NOT NULL CHECK \(phase IN \('features','evaluation','events','paper','alerts'\)\)/);
  assert.match(flat, /status text NOT NULL CHECK \(status IN \('running','completed','failed','held'\)\)/);
  assert.match(flat, /PRIMARY KEY \(as_of, phase\)/);
});

test("the event table records canonical transitions only, once per rules hash, stock and session", () => {
  assert.match(flat, /source text NOT NULL DEFAULT 'live' CHECK \(source = 'live'\)/);
  assert.match(flat, /UNIQUE \(rules_hash, stock_code, as_of\)/);
  for (const status of ["triggered", "setup", "unknown", "watch", "none"]) {
    assert.match(flat, new RegExp(`'${status}'`));
  }
});

test("the blob is keyed by its provenance-free hash and the feature row points at it", () => {
  assert.match(flat, /hash text PRIMARY KEY, body jsonb NOT NULL, first_seen date NOT NULL/);
  assert.match(flat, /fundamentals_hash text REFERENCES strategy_fundamentals_blobs\(hash\)/);
});

test("no table or index names a role, and nothing grants, owns, polices or secures", () => {
  for (const pattern of [
    /\bGRANT\b/i,
    /\bREVOKE\b/i,
    /\bOWNER TO\b/i,
    /\bCREATE POLICY\b/i,
    /\bROW LEVEL SECURITY\b/i,
    /\bFORCE\b/i,
    /\bSECURITY DEFINER\b/i,
    /\banon\b|\bauthenticated\b|\bPUBLIC\b/,
  ]) {
    assert.doesNotMatch(code, pattern, `must not match ${pattern}`);
  }
});

test("every index is created only when the catalog lacks it", () => {
  const outsideBlocks = code.replace(/DO \$[a-z0-9_]+\$[\s\S]*?\$[a-z0-9_]+\$;/g, "");
  assert.doesNotMatch(outsideBlocks, /CREATE (UNIQUE )?INDEX/i, "CREATE INDEX must sit inside a guarded DO block");
  for (const [tag, name, table] of [
    ["m156_idx_live", "idx_srv_one_live", "strategy_rule_versions \\(strategy_id\\)"],
    ["m156_idx_fhash", "idx_sfd_fundamentals_hash", "strategy_features_daily \\(fundamentals_hash\\)"],
    ["m156_idx_sse_strategy", "idx_sse_strategy_date", "strategy_signal_events \\(strategy_id, as_of DESC\\)"],
    ["m156_idx_sse_code", "idx_sse_code_date", "strategy_signal_events \\(stock_code, as_of DESC\\)"],
  ]) {
    const match = up.match(new RegExp(`DO \\$${tag}\\$([\\s\\S]*?)\\$${tag}\\$;`));
    assert.ok(match, `missing guarded block ${tag}`);
    assert.match(match[1], new RegExp(`to_regclass\\('public\\.${name}'\\) IS NULL`));
    assert.match(match[1], new RegExp(`CREATE (UNIQUE )?INDEX ${name} ON ${table}`));
  }
});

test("the live-version index is partial and unique, so one canonical live version per strategy", () => {
  assert.match(flat, /CREATE UNIQUE INDEX idx_srv_one_live ON strategy_rule_versions \(strategy_id\) WHERE status = 'live' AND kind = 'canonical';/);
});

test("nothing is inserted, updated, deleted or truncated by the file", () => {
  assert.doesNotMatch(code, /\bINSERT INTO\b/i);
  assert.doesNotMatch(code, /\bUPDATE\s+\w+\s+SET\b/i);
  assert.doesNotMatch(code, /\bDELETE FROM\b/i);
  assert.doesNotMatch(code, /\bTRUNCATE\b/i);
});

test("the down migration drops only what the up migration creates, guarded by IF EXISTS", () => {
  assert.match(down, /^BEGIN;/m);
  assert.match(down, /^COMMIT;/m);
  const drops = [...sqlOnly(down).matchAll(/^DROP [^\n;]*/gim)].map((m) => m[0]);
  assert.equal(drops.length, 7);
  for (const statement of drops) {
    assert.match(statement, /IF EXISTS/i, `not guarded: ${statement}`);
  }
  assert.doesNotMatch(sqlOnly(down), /\bGRANT\b/i);
});

test("the allowlist runs the daily snapshot after the strategy capture and 000153, and before the 000138 closer", () => {
  const line = "run_psql_session -f /migrations/000156_strategy_engine.up.sql";
  assert.equal(workflow.split(line).length - 1, 1, "allowlisted once");
  const at = workflow.indexOf(line);
  const capture = workflow.match(/run_psql_session -f \/migrations\/0001\d\d_strategy_capture\.up\.sql/);
  assert.ok(capture, "the strategy capture is allowlisted");
  assert.ok(at > workflow.indexOf(capture[0]), "after the strategy capture");
  assert.ok(at > workflow.indexOf("run_psql_session -f /migrations/000153_add_crawl_ops_indexes.up.sql"), "after 000153");
  assert.ok(at < workflow.indexOf("run_psql_session -f /migrations/000138_harden_data_api_grants.up.sql"), "before the 000138 closer");
});
