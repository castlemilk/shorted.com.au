import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const up = readFileSync(new URL("./000126_council_foundation.up.sql", import.meta.url), "utf8");
const down = readFileSync(new URL("./000126_council_foundation.down.sql", import.meta.url), "utf8");
const code = (sql) => sql.replace(/--.*$/gm, "");

// Each is filled by a collector mode; the migration adds nothing no mode fills.
const lgaColumns = {
  kind: "TEXT",
  display_name: "TEXT",
  slug: "TEXT",
  erp_year: "INTEGER",
  wikidata_qid: "TEXT",
  website: "TEXT",
  seifa_irsad_decile: "SMALLINT",
  seifa_irsd_decile: "SMALLINT",
  dwellings: "INTEGER",
  median_weekly_rent: "INTEGER",
  median_mortgage_monthly: "INTEGER",
  avg_household_size: "DOUBLE PRECISION",
};

test("every new council column is nullable and replay-safe — absent is not zero", () => {
  for (const [column, type] of Object.entries(lgaColumns)) {
    const re = new RegExp(`ADD COLUMN IF NOT EXISTS ${column}\\s+${type}[,;]`);
    assert.match(code(up), re, `${column} ${type}`);
  }
  assert.doesNotMatch(code(up), /ADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS)/i, "a bare ADD COLUMN fails on replay");
  for (const [column, type] of Object.entries(lgaColumns)) {
    const constrained = new RegExp(`ADD COLUMN IF NOT EXISTS ${column}\\s+${type}\\s+(NOT NULL|DEFAULT)`);
    assert.doesNotMatch(code(up), constrained, column);
  }
});

test("council kind and SEIFA deciles are constrained, guarded for replay", () => {
  assert.match(up, /CHECK \(kind IS NULL OR kind IN \('council', 'unincorporated', 'pseudo'\)\)/);
  assert.match(up, /seifa_irsad_decile IS NULL OR seifa_irsad_decile BETWEEN 1 AND 10/);
  assert.match(up, /seifa_irsd_decile IS NULL OR seifa_irsd_decile BETWEEN 1 AND 10/);
  // ADD CONSTRAINT has no IF NOT EXISTS, so each one sits behind a pg_constraint probe.
  const adds = code(up).match(/ADD CONSTRAINT (\w+)/g) ?? [];
  assert.equal(adds.length, 3);
  for (const add of adds) {
    const name = add.split(" ").pop();
    assert.match(up, new RegExp(`conname = '${name}'`), `${name} is not guarded`);
  }
});

test("slugs are unique per state, and only once minted", () => {
  assert.match(up, /CREATE UNIQUE INDEX IF NOT EXISTS idx_lga_state_slug\s+ON lga \(state_code, slug\) WHERE slug IS NOT NULL/);
});

test("the bridge records the dominant council's share in (0, 1]", () => {
  assert.match(up, /ALTER TABLE suburb_lga\s+ADD COLUMN IF NOT EXISTS dominant_share DOUBLE PRECISION;/);
  assert.match(up, /dominant_share IS NULL OR \(dominant_share > 0 AND dominant_share <= 1\)/);
});

test("lga_series is keyed per council, measure, period and source", () => {
  assert.match(up, /CREATE TABLE IF NOT EXISTS lga_series/);
  assert.match(up, /lga_code24\s+TEXT NOT NULL REFERENCES lga \(lga_code24\) ON DELETE CASCADE/);
  assert.match(up, /PRIMARY KEY \(lga_code24, measure, period, source\)/);
  for (const column of ["measure", "period_label", "unit", "source"]) {
    assert.match(up, new RegExp(`\\n\\s+${column}\\s+(TEXT|DATE) NOT NULL`), column);
  }
  assert.match(up, /period\s+DATE NOT NULL/);
  assert.match(up, /value\s+DOUBLE PRECISION NOT NULL/);
});

test("the unlicensed state is unstorable", () => {
  assert.match(up, /source_licence TEXT NOT NULL DEFAULT 'CC-BY-4\.0'/);
  assert.match(up, /CHECK \(source_licence <> 'proprietary-tos-restricted'\)/);
});

test("the migration touches no rows, so it can be replayed", () => {
  for (const dml of [/\bINSERT\s+INTO\b/i, /\bDELETE\s+FROM\b/i, /\bUPDATE\s+\w+\s+SET\b/i, /\bTRUNCATE\b/i]) {
    assert.doesNotMatch(code(up), dml);
  }
  // The guard has teeth: the same check rejects a migration that does write.
  assert.match(code(`${up}\nUPDATE lga SET kind = 'council';`), /\bUPDATE\s+\w+\s+SET\b/i);
});

test("down is the guarded inverse and leaves 000061's columns alone", () => {
  assert.match(down, /DROP TABLE IF EXISTS lga_series/);
  assert.match(down, /DROP INDEX IF EXISTS idx_lga_state_slug/);
  assert.match(down, /DROP COLUMN IF EXISTS dominant_share/);
  for (const column of Object.keys(lgaColumns)) {
    assert.match(down, new RegExp(`DROP COLUMN IF EXISTS ${column}\\b`), column);
  }
  for (const kept of ["population", "pop_growth_pct", "median_age", "pct_rented", "centroid_lat", "overlap_lgas"]) {
    assert.doesNotMatch(down, new RegExp(`DROP COLUMN IF EXISTS ${kept}\\b`), `${kept} belongs to 000061`);
  }
});
