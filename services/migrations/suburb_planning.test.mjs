import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const up = readFileSync(new URL("./000125_add_suburb_planning.up.sql", import.meta.url), "utf8");
const down = readFileSync(new URL("./000125_add_suburb_planning.down.sql", import.meta.url), "utf8");

// The ten harmonised zoning families (program decision 8). The collector,
// the Go column registry and the web palette all carry this same list.
const families = [
  "res_low",
  "res_medium_high",
  "centre_mixed",
  "industrial",
  "rural",
  "conservation",
  "open_space",
  "infrastructure",
  "water",
  "other",
];
const shareColumns = [
  ...families.map((f) => `zone_${f}_share_pct`),
  "zoning_coverage_pct",
  "heritage_share_pct",
];

test("the table is replay-safe and keyed to the suburb spine", () => {
  assert.match(up, /CREATE TABLE IF NOT EXISTS suburb_planning/);
  assert.match(up, /sal_code\s+TEXT PRIMARY KEY REFERENCES suburb_demographics\(sal_code\)/);
  assert.match(up, /CREATE INDEX IF NOT EXISTS/);
  // Named CHECKs inside CREATE TABLE ride on IF NOT EXISTS; a bare
  // ALTER TABLE … ADD CONSTRAINT would fail on the second replay.
  assert.doesNotMatch(up.replace(/--.*$/gm, ""), /ALTER\s+TABLE[^;]*ADD\s+CONSTRAINT/i);
});

test("the migration touches no rows, so the deploy can replay it", () => {
  const stripped = up.replace(/--.*$/gm, "");
  for (const dml of [/\bINSERT\s+INTO\b/i, /\bDELETE\s+FROM\b/i, /\bUPDATE\s+\w+\s+SET\b/i, /\bTRUNCATE\b/i]) {
    assert.doesNotMatch(stripped, dml);
  }
  const writes = `${up}\nINSERT INTO suburb_planning (sal_code) VALUES ('10001');`;
  assert.match(writes.replace(/--.*$/gm, ""), /\bINSERT\s+INTO\b/i);
});

test("every share is a nullable double bounded to 0..100 — absent is not zero", () => {
  for (const column of shareColumns) {
    assert.match(up, new RegExp(`${column}\\s+DOUBLE PRECISION,`), column);
    assert.doesNotMatch(up, new RegExp(`${column}\\s+DOUBLE PRECISION\\s+NOT NULL`), column);
    assert.doesNotMatch(up, new RegExp(`${column}\\s+DOUBLE PRECISION[^,]*DEFAULT`), column);
    assert.match(up, new RegExp(`${column}\\s+IS NULL\\s+OR\\s+${column}\\s+BETWEEN\\s+0\\s+AND\\s+100`), column);
  }
});

test("the dominant family is constrained to the harmonised set", () => {
  const check = up.match(/suburb_planning_family_check CHECK \(([\s\S]*?)\)\s*\),/);
  assert.ok(check, "family CHECK present");
  const listed = [...check[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...listed].sort(), [...families].sort());
});

test("NSW controls, instruments and sources are present and nullable", () => {
  for (const column of ["nsw_height_median_m", "nsw_height_max_m", "nsw_fsr_median", "nsw_min_lot_median_m2"]) {
    assert.match(up, new RegExp(`${column}\\s+DOUBLE PRECISION,`), column);
    assert.match(up, new RegExp(`${column}\\s+IS NULL\\s+OR\\s+${column}\\s+>\\s+0`), column);
  }
  assert.match(up, /heritage_item_count\s+INTEGER,/);
  assert.match(up, /heritage_item_count IS NULL OR heritage_item_count >= 0/);
  assert.match(up, /planning_instruments\s+TEXT\[\],/);
  assert.match(up, /zoning_source\s+TEXT,/);
  assert.match(up, /heritage_source\s+TEXT,/);
});

test("the unlicensed state is unstorable", () => {
  assert.match(up, /source_licence\s+TEXT NOT NULL DEFAULT 'CC-BY-4\.0'/);
  assert.match(up, /source_licence\s+<>\s+'proprietary-tos-restricted'/);
});

test("down is the guarded inverse", () => {
  assert.match(down, /DROP TABLE IF EXISTS suburb_planning/);
  assert.match(down, /DROP INDEX IF EXISTS idx_suburb_planning_dominant_family/);
});
