import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const up = readFileSync(
  new URL("./000115_add_suburb_elevation.up.sql", import.meta.url),
  "utf8",
);
const down = readFileSync(
  new URL("./000115_add_suburb_elevation.down.sql", import.meta.url),
  "utf8",
);

const elevationColumns = [
  "elevation_min_m",
  "elevation_median_m",
  "elevation_max_m",
];
const shareColumns = [
  "land_share_below_1m",
  "land_share_below_2m",
  "land_share_below_5m",
];
const allColumns = [...elevationColumns, ...shareColumns];

test("elevation columns are replay-safe nullable double precision values", () => {
  for (const column of allColumns) {
    assert.match(
      up,
      new RegExp(`ADD COLUMN IF NOT EXISTS\\s+${column}\\s+DOUBLE PRECISION`, "i"),
    );
  }
  assert.doesNotMatch(up, /(?:elevation|land_share)_[a-z0-9_]+\s+DOUBLE PRECISION\s+NOT NULL/i);
  assert.doesNotMatch(up, /(?:elevation|land_share)_[a-z0-9_]+\s+DOUBLE PRECISION[^,;]*DEFAULT/i);
});

test("guarded checks enforce share bounds and ordered elevation", () => {
  assert.match(up, /IF NOT EXISTS\s*\(\s*SELECT 1\s+FROM pg_constraint/i);
  assert.match(up, /ADD CONSTRAINT suburb_demographics_land_share_bounds_check\s+CHECK/i);
  for (const column of shareColumns) {
    assert.match(
      up,
      new RegExp(`${column}\\s+IS NULL\\s+OR\\s+${column}\\s+BETWEEN\\s+0\\s+AND\\s+100`, "i"),
    );
  }
  assert.match(up, /ADD CONSTRAINT suburb_demographics_elevation_order_check\s+CHECK/i);
  assert.match(
    up,
    /elevation_min_m\s*<=\s*elevation_median_m\s+AND\s+elevation_median_m\s*<=\s*elevation_max_m/i,
  );
});

test("down migration is the guarded inverse of the up migration", () => {
  assert.match(down, /DROP CONSTRAINT IF EXISTS suburb_demographics_land_share_bounds_check/i);
  assert.match(down, /DROP CONSTRAINT IF EXISTS suburb_demographics_elevation_order_check/i);
  for (const column of allColumns) {
    assert.match(down, new RegExp(`DROP COLUMN IF EXISTS\\s+${column}`, "i"));
  }
  assert.equal(
    (down.match(/DROP COLUMN IF EXISTS\s+(?:elevation|land_share)_[a-z0-9_]+/gi) ?? []).length,
    allColumns.length,
  );
});
