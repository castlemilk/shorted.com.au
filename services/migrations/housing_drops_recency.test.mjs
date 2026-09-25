import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (name) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");

const up = read("000124_housing_drops_recency.up.sql");
const down = read("000124_housing_drops_recency.down.sql");

const RECENCY = /last_seen_at >= now\(\) - interval '14 days'/;
const RECENCY_G = /last_seen_at >= now\(\) - interval '14 days'/g;

const LISTING_MVS = [
  "mv_suburb_listing_stats",
  "mv_suburb_price_drops",
  "mv_state_price_drops",
  "mv_agency_stats",
];

// Every view prod's refresh function covers (pg_proc, read 2026-09-23). The
// replacement must keep ALL of them — dropping mv_housing_headline or the crime
// view from the function would freeze them silently.
const REFRESHED_MVS = [
  "mv_housing_headline",
  "mv_suburb_price_drops",
  "mv_suburb_listing_stats",
  "mv_state_price_drops",
  "mv_agency_stats",
  "mv_suburb_crime_latest",
];

function mvBody(sql, name) {
  const body = sql.match(
    new RegExp(
      `CREATE MATERIALIZED VIEW ${name} AS([\\s\\S]*?)CREATE UNIQUE INDEX IF NOT EXISTS idx_${name}_key`,
      "i",
    ),
  )?.[1];
  assert.ok(body, `${name} definition must be present`);
  return body;
}

function cte(body, name, next) {
  const m = body.match(new RegExp(`${name} AS\\s*\\(([\\s\\S]*?)\\),\\s*${next} AS`, "i"));
  assert.ok(m, `CTE ${name} must be present (followed by ${next})`);
  return m[1];
}

test("000124 is one transaction that disarms the pooler's timeout in-session", () => {
  assert.match(up, /^BEGIN;$/m);
  assert.match(up, /^COMMIT;$/m);
  // Supavisor drops PGOPTIONS, so the only timeout override that works is one
  // issued inside the session.
  assert.match(up, /^SET LOCAL statement_timeout = 0;$/m);
  assert.match(down, /^SET LOCAL statement_timeout = 0;$/m);
});

test("every active and asking population is recency-gated to the 14-day sweep window", () => {
  const listing = mvBody(up, "mv_suburb_listing_stats");
  assert.match(cte(listing, "asking_addresses", "fs"), RECENCY);

  const suburbDrops = mvBody(up, "mv_suburb_price_drops");
  assert.match(cte(suburbDrops, "ev", "per_source"), RECENCY);
  assert.match(suburbDrops.match(/active AS\s*\(([\s\S]*?)\)\s*SELECT/i)?.[1] ?? "", RECENCY);

  const state = mvBody(up, "mv_state_price_drops");
  assert.match(cte(state, "ev", "per_source"), RECENCY);
  assert.match(cte(state, "active_addresses", "l"), RECENCY);

  const agency = mvBody(up, "mv_agency_stats");
  assert.match(cte(agency, "base", "ev"), RECENCY);
  assert.match(cte(agency, "ev", "per_addr"), RECENCY);

  // Every `pl.is_active` / `is_active` in a listing view sits next to the gate:
  // an ungated one is a zombie denominator creeping back in.
  for (const name of LISTING_MVS) {
    const body = mvBody(up, name);
    const active = (body.match(/\bis_active\b/g) ?? []).length;
    const gated = (body.match(RECENCY_G) ?? []).length;
    assert.ok(active > 0, `${name} must filter on is_active`);
    assert.ok(
      gated >= active,
      `${name}: ${active} is_active predicates but only ${gated} recency gates`,
    );
  }
});

test("000109 guards survive the rebuild", () => {
  for (const name of LISTING_MVS) {
    const body = mvBody(up, name);
    assert.match(body, /NULLIF\([^,]+address_key, ''\) IS NOT NULL/i, `${name} address unit`);
    assert.doesNotMatch(
      body,
      /\b(?:\w+\.)?source\b\s*\|\|\s*':'\s*\|\|\s*(?:\w+\.)?listing_id\b/i,
      `${name} must not fall back to portal identity`,
    );
    assert.match(up, new RegExp(`CREATE UNIQUE INDEX IF NOT EXISTS idx_${name}_key`));
  }
  for (const name of ["mv_suburb_price_drops", "mv_state_price_drops", "mv_agency_stats"]) {
    assert.match(mvBody(up, name), /e\.drop_pct <= 0\.40/, `${name} keeps the 40% cap`);
  }
  assert.match(up, /CASE WHEN fs\.for_sale_priced >= 3 THEN fs\.median_asking END/);
  assert.match(up, /CASE WHEN sold\.sold_count >= 3 THEN sold\.median_sold END/);
  assert.match(up, /CASE WHEN a\.dropped_listing_count >= 3 THEN a\.max_drop_abs END/);
  assert.match(up, /WHERE a\.dropped_listing_count >= 3;/);
  assert.match(up, /CASE WHEN d\.dropped_count >= 3 THEN d\.median_drop_pct END/);
  assert.match(up, /CASE WHEN COUNT\(\*\) >= 3 THEN AVG\(max_pct\) END AS avg_drop_pct/);
  assert.match(up, /WHERE ag\.active_listings >= 3;/);
  assert.equal((up.match(/interval '12 months'/g) ?? []).length, 2, "both sold windows");
  assert.match(up, /'\{\}'::text\[\] AS agent_names/);
});

test("state rollup publishes catalog coverage with the collector's catalog definition", () => {
  const state = mvBody(up, "mv_state_price_drops");
  const catalog = cte(state, "catalog", "states");
  // drop_index.go queryCatalogSizes: count(DISTINCT sal_code) ... WHERE sal_code IS NOT NULL
  assert.match(catalog, /COUNT\(DISTINCT sal_code\) AS catalog_suburbs/);
  assert.match(catalog, /WHERE sal_code IS NOT NULL/);
  assert.match(
    catalog,
    /COUNT\(DISTINCT sal_code\)\s+FILTER \(WHERE last_seen_at >= now\(\) - interval '14 days'\) AS suburbs_swept_14d/,
  );
  // Swept means SEEN, not active — the index admits a suburb on any sighting.
  assert.doesNotMatch(catalog, /is_active/);
  assert.match(catalog, /GROUP BY GROUPING SETS \(\(state_code\), \(\)\)/);
  // An unswept catalog state still gets a row rather than vanishing.
  assert.match(state, /SELECT state_code FROM u\s+UNION\s+SELECT state_code FROM catalog/);
  assert.match(state, /FROM states s/);
  assert.match(state, /COALESCE\(c\.suburbs_swept_14d, 0\) AS suburbs_swept_14d/);
  assert.match(state, /COALESCE\(c\.catalog_suburbs, 0\) AS catalog_suburbs/);
});

test("housing_mv_refresh exists, is replay-safe and is seeded for the rebuilt views", () => {
  assert.match(up, /CREATE TABLE IF NOT EXISTS housing_mv_refresh \(/);
  assert.match(up, /mv_name\s+text\s+PRIMARY KEY/);
  assert.match(up, /refreshed_at timestamptz NOT NULL/);
  assert.match(up, /data_through timestamptz\b/);
  const seed = up.match(/INSERT INTO housing_mv_refresh[\s\S]*?;/)?.[0] ?? "";
  for (const name of LISTING_MVS) assert.match(seed, new RegExp(`'${name}'`));
  assert.match(seed, /ON CONFLICT \(mv_name\) DO UPDATE/);
});

test("refresh function keeps 000107's guard shape for every view and records each success", () => {
  const fn = up.match(
    /CREATE OR REPLACE FUNCTION refresh_housing_materialized_views\(\)([\s\S]*?)\$\$;/,
  )?.[1];
  assert.ok(fn, "function body must be present");
  assert.doesNotMatch(fn, /EXCEPTION WHEN OTHERS THEN/i, "query_canceled must be caught explicitly");

  // Split into per-view blocks at each concurrent refresh.
  const blocks = fn.split(/REFRESH MATERIALIZED VIEW CONCURRENTLY /).slice(1);
  assert.deepEqual(
    blocks.map((b) => b.match(/^(\w+);/)?.[1]),
    REFRESHED_MVS,
    "must refresh exactly prod's views, in prod's order",
  );
  for (const [i, block] of blocks.entries()) {
    const mv = REFRESHED_MVS[i];
    assert.match(block, new RegExp(`REFRESH MATERIALIZED VIEW ${mv};`), `${mv} blocking fallback`);
    assert.match(block, new RegExp(`RAISE WARNING 'Skipping ${mv}: %'`), `${mv} outer guard`);
    assert.match(
      block,
      new RegExp(`INSERT INTO housing_mv_refresh[\\s\\S]*VALUES \\('${mv}', now\\(\\)`),
      `${mv} must record its refresh`,
    );
    // The record comes AFTER the refresh inside the same outer block, so a
    // skipped view keeps its old timestamp.
    const refreshAt = block.indexOf(`REFRESH MATERIALIZED VIEW ${mv};`);
    const recordAt = block.indexOf("INSERT INTO housing_mv_refresh");
    const skipAt = block.indexOf(`'Skipping ${mv}`);
    assert.ok(refreshAt < recordAt && recordAt < skipAt, `${mv}: refresh -> record -> outer guard`);
    // The bookkeeping write has its own guard so it can never undo the refresh.
    assert.match(block, new RegExp(`'Refreshed ${mv} but could not record it: %'`));
    assert.ok(
      (block.match(/EXCEPTION WHEN query_canceled OR OTHERS THEN/g) ?? []).length >= 3,
      `${mv}: concurrent, bookkeeping and outer guards`,
    );
  }
  // Non-crawl views carry no crawl horizon.
  assert.match(fn, /VALUES \('mv_housing_headline', now\(\), NULL\)/);
  assert.match(fn, /VALUES \('mv_suburb_crime_latest', now\(\), NULL\)/);
  assert.match(fn, /VALUES \('mv_suburb_price_drops', now\(\), v_crawl_through\)/);
  assert.match(
    up,
    /ALTER FUNCTION refresh_housing_materialized_views\(\) SET statement_timeout TO '0';/,
  );
});

test("drop-index median is nullable and historical sub-floor medians are withheld", () => {
  assert.match(
    up,
    /ALTER TABLE housing_drop_index_daily ALTER COLUMN median_drop_pct DROP NOT NULL;/,
  );
  assert.match(
    up,
    /UPDATE housing_drop_index_daily\s+SET median_drop_pct = NULL\s+WHERE dropped_addresses < 3/,
  );
});

test("down restores 000109 views, 000107 function and drops the bookkeeping table last", () => {
  assert.doesNotMatch(down, RECENCY, "down must remove the recency gate");
  assert.doesNotMatch(down, /catalog_suburbs|suburbs_swept_14d/);
  const fn = down.match(
    /CREATE OR REPLACE FUNCTION refresh_housing_materialized_views\(\)([\s\S]*?)\$\$;/,
  )?.[1];
  assert.ok(fn);
  assert.doesNotMatch(fn, /housing_mv_refresh/);
  for (const mv of REFRESHED_MVS) {
    assert.match(fn, new RegExp(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${mv};`));
  }
  for (const name of LISTING_MVS) {
    assert.match(down, new RegExp(`CREATE MATERIALIZED VIEW ${name} AS`));
  }
  assert.match(down, /SET median_drop_pct = 0\s+WHERE median_drop_pct IS NULL/);
  assert.match(down, /ALTER COLUMN median_drop_pct SET NOT NULL/);
  assert.ok(
    down.indexOf("DROP TABLE IF EXISTS housing_mv_refresh") >
      down.indexOf("CREATE OR REPLACE FUNCTION refresh_housing_materialized_views()"),
    "the function must stop writing the table before the table is dropped",
  );
});
