import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { classify } from "../../scripts/prod-psql-classify.mjs";

// 000144: autovacuum thresholds for shorts, news_articles and
// asx_announcements (DBP-04, 2026-10-21 database review). Hand-applied.

const read = (name) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
const code = (sql) => sql.replace(/--.*$/gm, "");

test("000144 sets the review's thresholds, only where the catalog lacks them", () => {
  const up = read("000144_autovacuum_append_tables.up.sql");
  assert.deepEqual(classify(up), { verdict: "transaction", reason: "" });
  const body = code(up);
  for (const [table, options] of [
    ["shorts", ["autovacuum_vacuum_insert_threshold=5000", "autovacuum_vacuum_insert_scale_factor=0", "autovacuum_analyze_threshold=2000", "autovacuum_analyze_scale_factor=0"]],
    ["news_articles", ["autovacuum_vacuum_scale_factor=0.02", "autovacuum_vacuum_insert_scale_factor=0.02", "autovacuum_analyze_scale_factor=0.02"]],
    ["asx_announcements", ["autovacuum_vacuum_insert_scale_factor=0.02", "autovacuum_analyze_scale_factor=0.02"]],
  ]) {
    assert.match(body, new RegExp(`\\('${table}', ARRAY\\[`));
    for (const option of options) assert.match(body, new RegExp(`'${option}'`), `${table} ${option}`);
  }
  // A replay reads the catalog and takes no lock.
  assert.match(body, /COALESCE\(reloptions, '\{\}'::text\[\]\) @> t\.opts/);
  assert.match(body, /SET LOCAL lock_timeout = '5s';/);
  // VACUUM cannot run in a transaction: the catch-up pass is an owner action.
  assert.doesNotMatch(body, /\bVACUUM\b/);
  const down = code(read("000144_autovacuum_append_tables.down.sql"));
  for (const table of ["shorts", "news_articles", "asx_announcements"]) {
    assert.match(down, new RegExp(`ALTER TABLE public\\.${table} RESET \\(`));
  }
});
