import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const up = readFileSync(
  new URL("./000114_add_suburb_census_expanded.up.sql", import.meta.url),
  "utf8",
);
const down = readFileSync(
  new URL("./000114_add_suburb_census_expanded.down.sql", import.meta.url),
  "utf8",
);

const percentageColumns = [
  "pct_low_personal_income",
  "pct_high_personal_income",
  "unemployment_rate",
  "labour_force_participation_rate",
  "pct_bachelor_or_higher",
  "pct_separate_house",
  "pct_flat_apartment",
  "pct_couple_with_children",
  "pct_lone_person_household",
];

test("expanded Census percentages are guarded nullable NUMERIC(5,2) columns", () => {
  assert.match(up, /ALTER TABLE IF EXISTS\s+suburb_demographics/i);
  for (const column of percentageColumns) {
    assert.match(
      up,
      new RegExp(`ADD COLUMN IF NOT EXISTS\\s+${column}\\s+NUMERIC\\(5,2\\)`, "i"),
    );
    assert.doesNotMatch(
      up,
      new RegExp(`${column}\\s+NUMERIC\\(5,2\\)[^,;]*(?:NOT NULL|DEFAULT)`, "i"),
    );
  }
});

test("one replay-safe CHECK bounds every expanded percentage to 0..100 or NULL", () => {
  assert.match(up, /IF NOT EXISTS\s*\(\s*SELECT 1\s+FROM pg_constraint/i);
  assert.match(up, /ADD CONSTRAINT suburb_demographics_census_expanded_pct_check\s+CHECK/i);
  for (const column of percentageColumns) {
    assert.match(
      up,
      new RegExp(`${column}\\s+IS NULL\\s+OR\\s+${column}\\s+BETWEEN\\s+0\\s+AND\\s+100`, "i"),
    );
  }
});

test("down migration is the guarded inverse of every expanded Census column", () => {
  assert.match(down, /ALTER TABLE IF EXISTS\s+suburb_demographics/i);
  assert.match(
    down,
    /DROP CONSTRAINT IF EXISTS suburb_demographics_census_expanded_pct_check/i,
  );
  for (const column of percentageColumns) {
    assert.match(down, new RegExp(`DROP COLUMN IF EXISTS\\s+${column}`, "i"));
  }
  assert.equal(
    (down.match(/DROP COLUMN IF EXISTS\s+(?:pct_[a-z_]+|unemployment_rate|labour_force_participation_rate)/gi) ?? []).length,
    percentageColumns.length,
  );
});
