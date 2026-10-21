import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { classify, splitStatements } from "../../scripts/prod-psql-classify.mjs";

// 000141-000143: the short-interest chart's covering index and the drop of the
// two indexes it supersedes (DBP-02, 2026-10-21 database review). Hand-applied,
// one statement per file.

const read = (name) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
const code = (sql) => sql.replace(/--.*$/gm, "");
const statements = (sql) => splitStatements(sql).map((s) => s.text);
const go = (path) => readFileSync(new URL(`../shorts/internal/store/shorts/${path}`, import.meta.url), "utf8");

const concurrentFiles = [
  "000141_shorts_timeseries_full_index.up.sql",
  "000141_shorts_timeseries_full_index.down.sql",
  "000142_drop_idx_shorts_product_code_date.up.sql",
  "000142_drop_idx_shorts_product_code_date.down.sql",
  "000143_drop_idx_shorts_timeseries_covering.up.sql",
  "000143_drop_idx_shorts_timeseries_covering.down.sql",
];

test("000141-000143 are one CONCURRENTLY statement each, so migrate up can run them", () => {
  // `migrate up` sends a file as one query string; with two statements Postgres
  // runs it as an implicit transaction and refuses CONCURRENTLY inside it.
  for (const file of concurrentFiles) {
    const sql = read(file);
    assert.equal(statements(sql).length, 1, `${file} must hold exactly one statement`);
    assert.match(code(sql), /\bCONCURRENTLY\b/, `${file} must not lock shorts against writes`);
    assert.match(code(sql), /\bIF (NOT )?EXISTS\b/, `${file} must be replay-safe`);
    assert.equal(classify(sql).verdict, "session", `${file}: db:prod:apply runs it outside a transaction`);
  }
});

test("000141 covers every column the short-interest chart reads", () => {
  const up = code(read("000141_shorts_timeseries_full_index.up.sql"));
  assert.match(
    up,
    /CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_shorts_timeseries_full\s+ON shorts \("PRODUCT_CODE", "DATE" DESC\)\s+INCLUDE \("PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS",\s+"REPORTED_SHORT_POSITIONS", "TOTAL_PRODUCT_IN_ISSUE"\);/,
  );
  const chart = go("postgres.go");
  for (const column of ["REPORTED_SHORT_POSITIONS", "TOTAL_PRODUCT_IN_ISSUE", "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS"]) {
    assert.match(chart, new RegExp(`AVG\\("${column}"\\)`), `GetStockData no longer averages ${column}?`);
  }
});

test("000142 and 000143 drop only the two indexes 000141 supersedes, and their downs rebuild them as defined", () => {
  assert.match(code(read("000142_drop_idx_shorts_product_code_date.up.sql")), /^\s*DROP INDEX CONCURRENTLY IF EXISTS idx_shorts_product_code_date;\s*$/);
  assert.match(code(read("000143_drop_idx_shorts_timeseries_covering.up.sql")), /^\s*DROP INDEX CONCURRENTLY IF EXISTS idx_shorts_timeseries_covering;\s*$/);
  // The original definitions (000001, 000022), rebuilt concurrently.
  assert.match(read("000001_initial_schema.up.sql"), /idx_shorts_product_code_date ON shorts\("PRODUCT_CODE", "DATE" DESC\)/);
  assert.match(code(read("000142_drop_idx_shorts_product_code_date.down.sql")), /idx_shorts_product_code_date\s+ON shorts \("PRODUCT_CODE", "DATE" DESC\);/);
  assert.match(
    code(read("000143_drop_idx_shorts_timeseries_covering.down.sql")),
    /idx_shorts_timeseries_covering\s+ON shorts \("PRODUCT_CODE", "DATE" DESC\)\s+INCLUDE \("PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS"\);/,
  );
});
