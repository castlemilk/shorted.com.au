import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const up = readFileSync(
  new URL("./000110_add_housing_drop_index.up.sql", import.meta.url),
  "utf8",
);

test("snapshot table is keyed so a re-run repairs rather than duplicates", () => {
  assert.match(up, /PRIMARY KEY \(snapshot_date, grain, grain_key\)/);
});

test("honesty columns exist — without them a crawl gap reads as a market move", () => {
  for (const col of ["panel_suburbs", "coverage_ratio", "is_gap"]) {
    assert.match(up, new RegExp(`\\b${col}\\b`), `missing ${col}`);
  }
});

test("grain is constrained to the three supported levels", () => {
  assert.match(up, /grain\s+text\s+NOT NULL/i);
  assert.match(up, /CHECK \(grain IN \('national', 'state', 'suburb'\)\)/);
});

test("is_gap fails closed — a missing flag must not read as a healthy day", () => {
  assert.match(up, /is_gap\s+boolean\s+NOT NULL DEFAULT true/i);
});
