import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const up = readFileSync(new URL("./000122_add_suburb_hazard_exposure.up.sql", import.meta.url), "utf8");
const down = readFileSync(new URL("./000122_add_suburb_hazard_exposure.down.sql", import.meta.url), "utf8");

const shareColumns = [
  "water_observed_share_pct",
  "permanent_water_share_pct",
  "flood_planning_share_pct",
  "bushfire_prone_share_pct",
];

test("the table is replay-safe and keyed to the suburb spine", () => {
  assert.match(up, /CREATE TABLE IF NOT EXISTS suburb_hazard_exposure/);
  assert.match(up, /sal_code\s+TEXT PRIMARY KEY REFERENCES suburb_demographics\(sal_code\)/);
  assert.match(up, /CREATE INDEX IF NOT EXISTS/);
  assert.doesNotMatch(up, /\bINSERT\b|\bUPDATE\b|\bDELETE\b/i);
});

test("every share is a nullable double bounded to 0..100 — absent is not zero", () => {
  for (const column of shareColumns) {
    assert.match(up, new RegExp(`${column}\\s+DOUBLE PRECISION,`));
    assert.doesNotMatch(up, new RegExp(`${column}\\s+DOUBLE PRECISION\\s+NOT NULL`));
    assert.doesNotMatch(up, new RegExp(`${column}\\s+DOUBLE PRECISION[^,]*DEFAULT`));
    assert.match(up, new RegExp(`${column}\\s+IS NULL\\s+OR\\s+${column}\\s+BETWEEN\\s+0\\s+AND\\s+100`));
  }
});

test("the unlicensed state is unstorable", () => {
  assert.match(up, /source_licence\s+TEXT NOT NULL DEFAULT 'CC-BY-4\.0'/);
  assert.match(up, /source_licence\s+<>\s+'proprietary-tos-restricted'/);
});

test("down is the guarded inverse", () => {
  assert.match(down, /DROP TABLE IF EXISTS suburb_hazard_exposure/);
  assert.match(down, /DROP INDEX IF EXISTS idx_suburb_hazard_exposure_flood/);
});
