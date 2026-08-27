import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const up = readFileSync(
  new URL("./000113_add_suburb_seifa.up.sql", import.meta.url),
  "utf8",
);
const down = readFileSync(
  new URL("./000113_add_suburb_seifa.down.sql", import.meta.url),
  "utf8",
);

const indexes = ["irsd", "irsad", "ier", "ieo"];
const decileColumns = indexes.flatMap((index) => [
  `seifa_${index}_decile_aus`,
  `seifa_${index}_decile_state`,
]);
const allColumns = indexes.flatMap((index) => [
  `seifa_${index}_score`,
  `seifa_${index}_decile_aus`,
  `seifa_${index}_decile_state`,
]);

test("SEIFA columns are nullable integers with replay-safe ADD guards", () => {
  for (const index of indexes) {
    assert.match(
      up,
      new RegExp(`ADD COLUMN IF NOT EXISTS\\s+seifa_${index}_score\\s+INTEGER`, "i"),
    );
    for (const suffix of ["decile_aus", "decile_state"]) {
      assert.match(
        up,
        new RegExp(`ADD COLUMN IF NOT EXISTS\\s+seifa_${index}_${suffix}\\s+SMALLINT`, "i"),
      );
    }
  }

  assert.doesNotMatch(up, /seifa_[a-z_]+\s+(?:INTEGER|SMALLINT)\s+NOT NULL/i);
  assert.doesNotMatch(up, /seifa_[a-z_]+\s+(?:INTEGER|SMALLINT)[^,;]*DEFAULT/i);
});

test("one replay-safe CHECK constrains every decile to 1..10 or NULL", () => {
  assert.match(up, /IF NOT EXISTS\s*\(\s*SELECT 1\s+FROM pg_constraint/i);
  assert.match(up, /ADD CONSTRAINT suburb_demographics_seifa_deciles_check\s+CHECK/i);
  for (const column of decileColumns) {
    assert.match(
      up,
      new RegExp(`${column}\\s+IS NULL\\s+OR\\s+${column}\\s+BETWEEN\\s+1\\s+AND\\s+10`, "i"),
    );
  }
});

test("down migration is the guarded inverse of every up-migration column", () => {
  assert.match(
    down,
    /DROP CONSTRAINT IF EXISTS suburb_demographics_seifa_deciles_check/i,
  );
  for (const column of allColumns) {
    assert.match(
      down,
      new RegExp(`DROP COLUMN IF EXISTS\\s+${column}`, "i"),
      `down migration does not remove ${column}`,
    );
  }
  assert.equal(
    (down.match(/DROP COLUMN IF EXISTS\s+seifa_[a-z_]+/gi) ?? []).length,
    allColumns.length,
    "down migration must remove exactly the 12 SEIFA columns",
  );
});
