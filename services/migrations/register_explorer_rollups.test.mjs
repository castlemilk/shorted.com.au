import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const up = readFileSync(
  new URL("./000104_add_register_explorer_rollups.up.sql", import.meta.url),
  "utf8",
);

const down = readFileSync(
  new URL("./000104_add_register_explorer_rollups.down.sql", import.meta.url),
  "utf8",
);

/** Strip `--` comments so prose about a measure can't satisfy a column assertion. */
const upCode = up.replace(/--.*$/gm, "");

/** The SELECT list of the named materialized view, comments stripped. */
function viewBody(name) {
  const start = upCode.indexOf(`CREATE MATERIALIZED VIEW ${name} AS`);
  assert.notEqual(start, -1, `materialized view ${name} not found`);
  const body = upCode.slice(start);
  const end = body.indexOf("\nCREATE UNIQUE INDEX");
  assert.notEqual(end, -1, `unterminated view body for ${name}`);
  return body.slice(0, end);
}

const rollup = viewBody("mv_register_politician_rollup");

// ---------------------------------------------------------------------------
// Rule 5: what is held, never how much. Counts only, and no column name may
// imply a magnitude even when the value behind it is a count.
// ---------------------------------------------------------------------------
test("no rollup column name implies an amount, a value or a portfolio", () => {
  const banned = /\bAS\s+\w*(amount|value|salary|worth|price|cost|portfolio)\w*\b/i;
  assert.doesNotMatch(upCode, banned, "000104 declares a column implying magnitude");
});

// ---------------------------------------------------------------------------
// "Properties" means DECLARED REAL-ESTATE ENTRIES (item 3). Counting distinct
// sal_code published the resolver's hit rate as the member's holdings: only a
// minority of item-3 rows resolve to an ABS suburb, so members declaring 13-18
// entries read as 0 and the hub tile read 38 against 1,248 item-3 rows.
// ---------------------------------------------------------------------------
test("property_count counts currently-declared item-3 rows, not resolved suburbs", () => {
  assert.match(
    rollup,
    /count\(\*\)\s*FILTER\s*\(WHERE item_no = 3 AND currently_declared\)::INTEGER AS property_count/,
    "property_count must count currently-declared item-3 rows",
  );
  assert.doesNotMatch(
    rollup,
    /count\(DISTINCT sal_code\)[^\n]*AS property_count/,
    "property_count must never be a distinct-suburb measure",
  );
});

test("the property measure matches the shape mv_register_suburb_property uses", () => {
  const suburbProperty = readFileSync(
    new URL("./000096_add_register_of_interests.up.sql", import.meta.url),
    "utf8",
  );
  // 000096 counts item-3 ROWS per suburb; the rollup counts item-3 ROWS per
  // member. Same unit on both sides of the feature.
  assert.match(suburbProperty, /WHERE hp\.item_no = 3/);
  assert.match(rollup, /item_no = 3 AND currently_declared/);
});

// ---------------------------------------------------------------------------
// Politician.declared_listed_count / declared_property_count are ALL-TIME
// counts on every other read path (politicianSelect in postgres_politicians.go).
// The rollup carries columns with exactly those semantics so the explorer rpcs
// cannot report a different number for the same person.
// ---------------------------------------------------------------------------
test("all-time company and suburb counts exist with no currently_declared filter", () => {
  assert.match(
    rollup,
    /count\(DISTINCT stock_code\) FILTER \(WHERE stock_code IS NOT NULL\)::INTEGER AS alltime_company_count/,
  );
  assert.match(
    rollup,
    /count\(DISTINCT sal_code\) FILTER \(WHERE sal_code IS NOT NULL\)::INTEGER AS alltime_suburb_count/,
  );
  for (const column of ["alltime_company_count", "alltime_suburb_count"]) {
    const projection = new RegExp(`AS ${column}\\b`);
    assert.match(rollup, projection, `${column} must be projected`);
    assert.match(
      rollup,
      new RegExp(`COALESCE\\(h\\.${column}, 0\\)::INTEGER AS ${column}`),
      `${column} must survive the LEFT JOIN for members with no holdings`,
    );
  }
  // The currently-declared measures stay, on their own names.
  assert.match(rollup, /FILTER \(WHERE currently_declared AND stock_code IS NOT NULL\)::INTEGER AS distinct_company_count/);
});

// ---------------------------------------------------------------------------
// The monthly grid is frozen at REFRESH time. Readers must window on the view's
// own max(month), or the sparkline shrinks by a point per late month and
// eventually empties while the tiles beside it keep rendering.
// ---------------------------------------------------------------------------
test("the monthly view documents the max(month) reader contract", () => {
  assert.match(
    up,
    /CURRENT_DATE at REFRESH time[\s\S]*max\(month\)[\s\S]*CREATE MATERIALIZED VIEW mv_register_politician_monthly/,
    "the CURRENT_DATE anchor must carry the reader contract next to it",
  );
  assert.match(
    viewBody("mv_register_politician_monthly"),
    /generate_series\([\s\S]*date_trunc\('month', CURRENT_DATE\)/,
    "the grid itself stays anchored to CURRENT_DATE at refresh time",
  );
});

// ---------------------------------------------------------------------------
// Refresh hygiene, matching 000095's posture (WHEN OTHERS does not catch 57014).
// ---------------------------------------------------------------------------
test("both explorer views are refreshed under query_canceled-aware guards", () => {
  for (const mv of [
    "mv_register_politician_rollup",
    "mv_register_politician_monthly",
  ]) {
    assert.match(up, new RegExp(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${mv};`));
    assert.match(up, new RegExp(`REFRESH MATERIALIZED VIEW ${mv};`));
  }
  assert.doesNotMatch(up, /EXCEPTION WHEN OTHERS THEN/);
  assert.match(up, /ALTER FUNCTION refresh_register_materialized_views\(\) SET statement_timeout TO '0';/i);
});

test("down migration removes both views and restores the refresh function", () => {
  for (const mv of [
    "mv_register_politician_rollup",
    "mv_register_politician_monthly",
  ]) {
    assert.match(down, new RegExp(`DROP MATERIALIZED VIEW IF EXISTS ${mv};`));
    assert.doesNotMatch(
      down,
      new RegExp(`REFRESH MATERIALIZED VIEW (CONCURRENTLY )?${mv};`),
      `the restored function must not refresh the dropped ${mv}`,
    );
  }
  assert.match(down, /CREATE OR REPLACE FUNCTION refresh_register_materialized_views\(\)/);
});
