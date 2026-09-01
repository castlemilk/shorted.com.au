import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const sql = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "000118_add_industry_history.up.sql",
  ),
  "utf8",
);

// This migration is in the deploy allowlist, which re-runs it on EVERY deploy.
// A single non-idempotent statement here fails the whole apply, and the apply is
// what deploys the API.
test("every statement is replay-safe", () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS stock_industry_history/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION record_industry_change/);
  assert.match(sql, /DROP TRIGGER IF EXISTS trg_record_industry_change/);

  for (const idx of sql.match(/CREATE (UNIQUE )?INDEX[^;]*/g) ?? []) {
    assert.match(idx, /IF NOT EXISTS/, `index is not replay-safe:\n${idx}`);
  }
  for (const ins of sql.match(/INSERT INTO[^;]*/g) ?? []) {
    assert.match(ins, /ON CONFLICT/, `insert would duplicate on replay:\n${ins}`);
  }
  // Rebuilding a materialized view on every deploy is the one thing the ledger
  // forbids outright; assert this migration does not.
  assert.doesNotMatch(sql, /MATERIALIZED VIEW/);
});

// The seeded baseline records what the label WAS when capture began. It is not
// evidence the classification changed that day — the real assignment date is
// unknown and unknowable, because company-metadata holds one current row per
// stock and updated_at is a bulk-sweep timestamp identical across every row.
// Conflating the two would let a caller date a sector change to the day we
// happened to deploy.
test("the baseline is distinguishable from an observed change", () => {
  assert.match(sql, /source\s+VARCHAR\(16\)/);
  assert.match(sql, /CHECK \(source IN \('seed', 'observed'\)\)/);
  assert.match(sql, /'seed'\s*\n?\s*FROM "company-metadata"/s);
});

// A change landing on the same day as the baseline collapses into that row.
// Leaving it marked 'seed' would label an observed value as a baseline.
test("an observed change relabels a row it collapses into", () => {
  const conflict = sql.match(/ON CONFLICT \(stock_code, observed_from\) DO UPDATE[^;]*/s);
  assert.ok(conflict, "the trigger must upsert, not fail, on a same-day change");
  assert.match(conflict[0], /source = 'observed'/);
});

// <> would silently ignore a label going to or from NULL, and both directions
// are real classification changes.
test("null transitions count as changes", () => {
  assert.match(sql, /NEW\.industry IS DISTINCT FROM OLD\.industry/);
  assert.doesNotMatch(sql, /NEW\.industry <> OLD\.industry/);
});

// Prod's company-metadata has no `sector` column — only `industry`. Selecting
// one that is not there would 500 every write to the table the trigger is on.
test("it touches no column prod does not have", () => {
  assert.doesNotMatch(sql, /\bNEW\.sector\b/);
  assert.doesNotMatch(sql, /SELECT[^;]*\bsector\b[^;]*FROM "company-metadata"/s);
});
