import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { classify } from "../../scripts/prod-psql-classify.mjs";

// 000140: the federal-division index behind the politician pages (DBP-05,
// 2026-10-21 database review). Hand-applied.

const read = (name) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
const code = (sql) => sql.replace(/--.*$/gm, "");
const go = (path) => readFileSync(new URL(`../shorts/internal/store/shorts/${path}`, import.meta.url), "utf8");

test("000140 indexes exactly the division expression the politician readers filter on", () => {
  const up = read("000140_suburb_demographics_division_index.up.sql");
  assert.deepEqual(classify(up), { verdict: "transaction", reason: "" });
  assert.match(
    code(up),
    /CREATE INDEX idx_suburb_demographics_federal_division\s+ON public\.suburb_demographics \(\(upper\(btrim\(federal_division\)\)\)\)\s+INCLUDE \(federal_party, federal_party_ab\);/,
  );
  // Built (and the table analyzed) only when absent: a replay takes no lock.
  assert.match(code(up), /IF to_regclass\('public\.idx_suburb_demographics_federal_division'\) IS NULL THEN/);
  // Not partial: the represented-suburbs read has no party predicate.
  assert.doesNotMatch(code(up), /WHERE federal_party/);
  // Plain build on a 15k-row table, so the file stays one transaction.
  assert.doesNotMatch(code(up), /CONCURRENTLY/);
  assert.match(code(up), /SET LOCAL lock_timeout = '5s';/);
  // The readers still use the indexed expression, character for character.
  const readers = go("postgres_politician_explorer.go") + go("postgres_politicians.go");
  const uses = readers.match(/upper\(btrim\(federal_division\)\) = upper\(btrim\(/g) ?? [];
  assert.ok(uses.length >= 4, `expected the four division lookups, found ${uses.length}`);
  assert.match(read("000140_suburb_demographics_division_index.down.sql"), /DROP INDEX IF EXISTS idx_suburb_demographics_federal_division;/);
});
