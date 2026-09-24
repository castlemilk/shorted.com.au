import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (name) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");

const up = read("000127_council_price_drops_mv.up.sql");
const down = read("000127_council_price_drops_mv.down.sql");
const m124 = read("000124_housing_drops_recency.up.sql");

// Every view prod's refresh function covers after 000124 (pg_proc, verified
// identical to 000124's body on 2026-09-24), then the council view LAST, so a
// failure in the new block can never delay the views the site already serves.
const REFRESHED_MVS = [
  "mv_housing_headline",
  "mv_suburb_price_drops",
  "mv_suburb_listing_stats",
  "mv_state_price_drops",
  "mv_agency_stats",
  "mv_suburb_crime_latest",
  "mv_council_price_drops",
];

const fnBody = (sql) =>
  sql.match(/CREATE OR REPLACE FUNCTION refresh_housing_materialized_views\(\)([\s\S]*?)\$\$;/)?.[1];

const viewBody = () => {
  const body = up.match(
    /CREATE MATERIALIZED VIEW IF NOT EXISTS mv_council_price_drops AS([\s\S]*?);\n/,
  )?.[1];
  assert.ok(body, "view definition must be present");
  return body;
};

test("000127 is one transaction that disarms the pooler's timeout in-session", () => {
  for (const sql of [up, down]) {
    assert.match(sql, /^BEGIN;$/m);
    assert.match(sql, /^COMMIT;$/m);
    assert.match(sql, /^SET LOCAL statement_timeout = 0;$/m);
  }
});

test("000127 is replay-safe: a replay never rebuilds, duplicates or re-stamps anything", () => {
  assert.doesNotMatch(up, /DROP MATERIALIZED VIEW/i, "a replay must not rebuild the view");
  assert.match(up, /CREATE MATERIALIZED VIEW IF NOT EXISTS mv_council_price_drops AS/);
  assert.match(
    up,
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_council_price_drops_key\s+ON mv_council_price_drops \(state_code, lga_code24, sal_code\);/,
  );
  assert.match(up, /CREATE INDEX IF NOT EXISTS idx_lga_series_public_latest/);
  // Every CREATE is guarded.
  for (const stmt of up.match(/^CREATE [A-Z ]+/gm) ?? []) {
    assert.match(stmt, /IF NOT EXISTS|OR REPLACE/, `unguarded: ${stmt}`);
  }
  // The seed stamp is written once: a replay must not claim a refresh that did
  // not happen.
  const seed = up.match(/INSERT INTO housing_mv_refresh[\s\S]*?;/)?.[0] ?? "";
  assert.match(seed, /'mv_council_price_drops'/);
  assert.match(seed, /ON CONFLICT \(mv_name\) DO NOTHING/);
  // No other data is touched.
  assert.doesNotMatch(up, /^\s*(UPDATE|DELETE)\b/im);
});

test("the view keeps every drops guard and never exposes a listing", () => {
  const body = viewBody();
  assert.match(body, /pl\.last_seen_at >= now\(\) - interval '14 days'/, "000124 recency gate");
  assert.match(body, /pl\.is_active/);
  assert.match(body, /NULLIF\(pl\.address_key, ''\) IS NOT NULL/, "address unit");
  assert.match(body, /e\.observed_at >= now\(\) - interval '30 days'/);
  assert.match(body, /e\.drop_pct <= 0\.40/, "40% sanity cap");
  assert.match(body, /e\.event_type = 'price_drop'/);
  assert.match(body, /DISTINCT ON \(sal_code, address_key\)[\s\S]*ORDER BY sal_code, address_key, total_abs DESC, source/);
  assert.match(body, /CASE WHEN x\.n >= 3 THEN x\.median_pct END AS median_drop_pct/, "k>=3 suburb floor");
  assert.match(body, /COALESCE\(t\.sal_code, ''\) AS sal_code/, "council total keyed ''");
  // Aggregates only: no listing identity, address or price leaves the view.
  const select = body.slice(body.lastIndexOf("SELECT t.state_code"));
  for (const col of ["address_key", "listing_id", "pl.price", "drop_abs", "\\bid\\b"]) {
    assert.doesNotMatch(select, new RegExp(col), `final select must not carry ${col}`);
  }
});

test("the refresh function is 000124's body verbatim plus one guarded council block", () => {
  const before = fnBody(m124);
  const after = fnBody(up);
  assert.ok(before && after);
  const tail = /\nEND;\s*$/;
  const base = before.replace(tail, "\n");
  assert.ok(after.startsWith(base), "every 000124 block must survive unchanged, in order");

  const blocks = after.split(/REFRESH MATERIALIZED VIEW CONCURRENTLY /).slice(1);
  assert.deepEqual(blocks.map((b) => b.match(/^(\w+);/)?.[1]), REFRESHED_MVS);
  const council = blocks.at(-1);
  assert.match(council, /REFRESH MATERIALIZED VIEW mv_council_price_drops;/, "blocking fallback");
  assert.match(council, /VALUES \('mv_council_price_drops', now\(\), v_crawl_through\)/);
  assert.match(council, /'Refreshed mv_council_price_drops but could not record it: %'/);
  assert.match(council, /RAISE WARNING 'Skipping mv_council_price_drops: %'/);
  assert.equal((council.match(/EXCEPTION WHEN query_canceled OR OTHERS THEN/g) ?? []).length, 3);
  assert.doesNotMatch(after, /EXCEPTION WHEN OTHERS THEN/i, "query_canceled must be caught explicitly");
  const refreshAt = council.indexOf("REFRESH MATERIALIZED VIEW mv_council_price_drops;");
  const recordAt = council.indexOf("INSERT INTO housing_mv_refresh");
  const skipAt = council.indexOf("'Skipping mv_council_price_drops");
  assert.ok(refreshAt < recordAt && recordAt < skipAt, "refresh -> record -> outer guard");
  assert.match(up, /ALTER FUNCTION refresh_housing_materialized_views\(\) SET statement_timeout TO '0';/);
});

test("down restores 000124's function before it drops the view", () => {
  assert.equal(fnBody(down), fnBody(m124), "down must restore 000124's body verbatim");
  const restoreAt = down.indexOf("CREATE OR REPLACE FUNCTION refresh_housing_materialized_views()");
  const dropAt = down.indexOf("DROP MATERIALIZED VIEW IF EXISTS mv_council_price_drops;");
  assert.ok(restoreAt >= 0 && dropAt > restoreAt, "no refresh may ever name a dropped view");
  assert.match(down, /ALTER FUNCTION refresh_housing_materialized_views\(\) SET statement_timeout TO '0';/);
  assert.match(down, /DELETE FROM housing_mv_refresh WHERE mv_name = 'mv_council_price_drops';/);
  assert.match(down, /DROP INDEX IF EXISTS idx_lga_series_public_latest;/);
});
