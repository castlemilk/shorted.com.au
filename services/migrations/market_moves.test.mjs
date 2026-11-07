// node --test services/migrations/market_moves.test.mjs
//
// 000160 is the market-moves table the market-moves workflow posts to, and the table of the tokens it
// posts with (created in the admin console). Prod replays every allowlisted
// migration on every deploy, so the file must be replay-safe, touch no row, grant nothing, and sit in the
// allowlist before the 000138 closer. The store's container test
// (services/shorts/internal/store/shorts, TestMarketMovesAgainstPostgres) runs it against a live Postgres.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const up = readFileSync(new URL("./000160_market_moves.up.sql", import.meta.url), "utf8");
const down = readFileSync(new URL("./000160_market_moves.down.sql", import.meta.url), "utf8");
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
  assert.ok(up.indexOf("SET LOCAL lock_timeout") < up.indexOf("CREATE TABLE IF NOT EXISTS market_moves"));
});

test("both tables and every index are replay-safe", () => {
  const creates = [...code.matchAll(/^CREATE TABLE\b[^\n]*/gim)].map((m) => m[0]);
  assert.deepEqual(creates, [
    "CREATE TABLE IF NOT EXISTS market_moves (",
    "CREATE TABLE IF NOT EXISTS market_moves_tokens (",
  ]);
  const indexes = [...code.matchAll(/^CREATE (UNIQUE )?INDEX\b[^;]*/gim)].map((m) => m[0]);
  assert.ok(indexes.length >= 3);
  for (const index of indexes) {
    assert.match(index, /IF NOT EXISTS/i, index);
    assert.match(index, / ON market_moves\b(?!_)/, `${index} indexes only the new table`);
  }
  assert.doesNotMatch(code, /\bCONCURRENTLY\b/i, "CONCURRENTLY cannot run inside the transaction");
});

test("a move is keyed by its poster's key and names what moved", () => {
  assert.match(flat, /move_key TEXT NOT NULL CONSTRAINT market_moves_move_key_key UNIQUE/);
  assert.match(flat, /CHECK \(move_key ~ '\^\[a-z0-9\]\[a-z0-9\._:-\]\{2,127\}\$'\)/);
  assert.match(flat, /CHECK \(kind IN \('stock', 'index', 'sector', 'market'\)\)/);
  assert.match(flat, /\(kind <> 'stock' OR stock_code IS NOT NULL\)/);
  assert.match(flat, /\(kind <> 'index' OR index_code IS NOT NULL\)/);
  assert.match(flat, /\(kind <> 'sector' OR sector IS NOT NULL\)/);
});

test("every figure carries its own date and an unknown number stays NULL", () => {
  assert.match(flat, /observed_at TIMESTAMPTZ NOT NULL/);
  assert.match(flat, /market_date DATE NOT NULL/);
  // change_pct, price and volume_ratio are nullable: a missing figure is never stored as 0.
  for (const column of ["change_pct", "price", "volume_ratio"]) {
    const def = flat.match(new RegExp(`${column} NUMERIC\\([^)]*\\)[^,]*,`));
    assert.ok(def, `${column} is defined`);
    assert.doesNotMatch(def[0], /NOT NULL|DEFAULT/, `${column} has no NOT NULL and no default`);
  }
});

test("a retraction is a status with a time, never a deleted row", () => {
  assert.match(flat, /CHECK \(status IN \('published', 'retracted'\)\)/);
  assert.match(flat, /CHECK \(\(status = 'retracted'\) = \(retracted_at IS NOT NULL\)\)/);
  assert.match(flat, /WHERE status = 'published'/);
});

test("a token is stored as its hash, never as itself", () => {
  const table = flat.slice(flat.indexOf("CREATE TABLE IF NOT EXISTS market_moves_tokens"));
  assert.match(table, /token_hash TEXT NOT NULL CONSTRAINT market_moves_tokens_hash_key UNIQUE/);
  assert.match(table, /CHECK \(token_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  assert.match(table, /CHECK \(token_prefix ~ '\^smm_\[A-Za-z0-9_-\]\{6\}\$'\)/);
  // No column could hold the token: every TEXT column is named and bounded or audited.
  const columns = [...table.matchAll(/\b([a-z_]+) (TEXT|TIMESTAMPTZ|BIGSERIAL)\b/g)].map((m) => m[1]);
  assert.deepEqual(columns.sort(), [
    "created_at", "created_by", "expires_at", "id", "last_used_at", "name", "revoked_at", "revoked_by", "token_hash", "token_prefix",
  ].sort());
  assert.match(table, /CHECK \(\(revoked_at IS NULL\) = \(revoked_by IS NULL\)\)/);
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
    /\bALTER TABLE\b/i,
  ]) {
    assert.doesNotMatch(code, pattern, `must not match ${pattern}`);
  }
});

test("the down migration drops only the two tables, guarded by IF EXISTS", () => {
  assert.match(down, /^BEGIN;/m);
  assert.match(down, /^COMMIT;/m);
  const drops = [...sqlOnly(down).matchAll(/^DROP [^\n;]*/gim)].map((m) => m[0]);
  assert.deepEqual(drops, ["DROP TABLE IF EXISTS market_moves_tokens", "DROP TABLE IF EXISTS market_moves"]);
});

test("the allowlist runs the market-moves migration once, before the 000138 closer", () => {
  const line = "run_psql_session -f /migrations/000160_market_moves.up.sql";
  assert.equal(workflow.split(line).length - 1, 1, "allowlisted once");
  const at = workflow.indexOf(line);
  assert.ok(at > 0);
  assert.ok(at < workflow.indexOf("run_psql_session -f /migrations/000138_harden_data_api_grants.up.sql"), "before the 000138 closer");
});
