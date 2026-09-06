import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  path.join(here, "000120_industry_history_on_insert.up.sql"),
  "utf8",
);

// 000118 captured industry CHANGES. A stock that arrives after its baseline
// seed fires no UPDATE, so it got no history row at all — and when it was later
// reclassified, the timeline recorded only the NEW label and dated it to the
// reclassification. That is worse than a gap: the history then claims the stock
// always carried its current sector, which is the lookahead #557 exists to
// remove, reintroduced by the mechanism built to prevent it.
//
// Observed before this migration:
//   INSERT ZZNEW industry='Materials'  ->  <no history row>
//   UPDATE ZZNEW industry='Energy'     ->  "Energy @2026-09-06 (observed)"
test("an INSERT trigger exists, not only an UPDATE one", () => {
  assert.match(sql, /AFTER INSERT ON "company-metadata"/);
  assert.match(sql, /AFTER UPDATE ON "company-metadata"/,
    "recreating the function must not drop the change-capture path");
  assert.match(sql, /IF TG_OP = 'INSERT' THEN/);
});

// 'seed' means "the label as it stood when capture began". For a stock arriving
// now, capture begins now: it is where our knowledge starts, not a change we
// witnessed. Marking it 'observed' would assert a reclassification that never
// happened, which is the same class of false precision the seed/observed split
// was introduced to avoid.
test("a first classification is recorded as seed, not observed", () => {
  const insertBranch = sql.slice(
    sql.indexOf("IF TG_OP = 'INSERT' THEN"),
    sql.indexOf("RETURN NEW;", sql.indexOf("IF TG_OP = 'INSERT' THEN")),
  );
  assert.match(insertBranch, /'seed'/);
  assert.doesNotMatch(insertBranch, /'observed'/,
    "the INSERT path must not claim to have witnessed a change");
  // DO NOTHING, not DO UPDATE: a row already present for today was written by
  // something that knows more than this INSERT does.
  assert.match(insertBranch, /ON CONFLICT \(stock_code, observed_from\) DO NOTHING/);
});

test("a stock with no classification yet is skipped rather than stored blank", () => {
  // An empty label is not a classification, and storing one would put a row in
  // the timeline that a caller has to know to ignore.
  assert.match(sql, /NEW\.industry IS NOT NULL AND NEW\.industry <> ''/);
});

// The population the missing trigger dropped is exactly the stocks added
// between 000118 and now. They need a row or they stay invisible forever.
test("existing rows with no history are caught up", () => {
  assert.match(sql, /NOT EXISTS \(\s*SELECT 1 FROM stock_industry_history/s);
  assert.match(sql, /ON CONFLICT \(stock_code, observed_from\) DO NOTHING/);
});

// Same ledger rule as 000118: this is deploy-allowlisted and re-runs on every
// deploy, so a single non-idempotent statement fails the apply that ships the API.
test("every statement is replay-safe", () => {
  assert.match(sql, /CREATE OR REPLACE FUNCTION record_industry_change/);
  for (const trg of sql.match(/CREATE TRIGGER[^;]*/g) ?? []) {
    const name = /CREATE TRIGGER (\w+)/.exec(trg)?.[1];
    assert.match(sql, new RegExp(`DROP TRIGGER IF EXISTS ${name}`),
      `trigger ${name} is created without being dropped first`);
  }
  for (const ins of sql.match(/INSERT INTO[^;]*/g) ?? []) {
    assert.match(ins, /ON CONFLICT/, `insert would duplicate on replay:\n${ins}`);
  }
  assert.doesNotMatch(sql, /MATERIALIZED VIEW/);
  // No bare ADD COLUMN / DROP: this migration only replaces behaviour.
  assert.doesNotMatch(sql, /ALTER TABLE[^;]*ADD COLUMN(?! IF NOT EXISTS)/);
});
