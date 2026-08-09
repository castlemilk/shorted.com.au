import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

function migration(number, direction) {
  const name = `${number}.${direction}.sql`;
  const url = new URL(`./${name}`, import.meta.url);
  assert.ok(existsSync(url), `${name} must exist`);
  return readFileSync(url, "utf8");
}

test("000107 hardens every housing MV refresh against query cancellation", () => {
  const up = migration("000107_harden_housing_mv_refresh", "up");
  const down = migration("000107_harden_housing_mv_refresh", "down");
  const views = [
    "mv_housing_headline",
    "mv_suburb_price_drops",
    "mv_suburb_listing_stats",
    "mv_state_price_drops",
    "mv_agency_stats",
    "mv_suburb_crime_latest",
  ];

  for (const view of views) {
    assert.match(up, new RegExp(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${view};`));
    assert.match(up, new RegExp(`REFRESH MATERIALIZED VIEW ${view};`));
  }
  assert.doesNotMatch(up, /EXCEPTION WHEN OTHERS THEN/i);
  assert.ok(
    (up.match(/EXCEPTION WHEN query_canceled OR OTHERS THEN/gi) ?? []).length >=
      views.length * 2,
    "each concurrent refresh and fallback must be independently guarded",
  );
  assert.match(
    up,
    /ALTER FUNCTION refresh_housing_materialized_views\(\) SET statement_timeout TO '0';/i,
  );
  assert.match(
    down,
    /ALTER FUNCTION refresh_housing_materialized_views\(\) RESET statement_timeout;/i,
  );
});

test("collector disables its caller-side timeout before invoking the housing refresh", () => {
  const store = readFileSync(
    new URL("../house-price-collector/store.go", import.meta.url),
    "utf8",
  );
  assert.match(
    store,
    /SET statement_timeout\s*=\s*0;\s*SELECT refresh_housing_materialized_views\(\)/i,
  );
});

test("000108 computes headline deltas within each source", () => {
  const up = migration("000108_fix_housing_headline_source_lags", "up");
  const down = migration("000108_fix_housing_headline_source_lags", "down");

  assert.match(
    up,
    /WINDOW w AS \(PARTITION BY region_code, measure, dwelling_type, source ORDER BY period\)/i,
  );
  assert.match(
    up,
    /PARTITION BY region_code, measure, dwelling_type\s+ORDER BY period DESC, source/i,
  );
  assert.match(up, /source_licence <> 'proprietary-tos-restricted'/i);
  assert.doesNotMatch(
    down,
    /PARTITION BY region_code, measure, dwelling_type, source/i,
  );
});

test("000109 aligns privacy floors, address units, sold windows, and drop shares", () => {
  const up = migration("000109_fix_listing_rollup_correctness", "up");
  const down = migration("000109_fix_listing_rollup_correctness", "down");

  assert.match(up, /interval '12 months'/i, "sold aggregates need an explicit window");
  assert.match(up, /event_type IN \('first_seen', 'status_change'\)/i);
  assert.match(up, /listing_status = 'sold'/i);

  assert.match(up, /CASE WHEN[\s\S]*for_sale_priced[\s\S]*>= 3 THEN[\s\S]*avg_asking/i);
  assert.match(up, /CASE WHEN[\s\S]*sold_count[\s\S]*>= 3 THEN[\s\S]*avg_sold/i);
  assert.match(up, /CASE WHEN COUNT\(\*\) >= 3 THEN COUNT\(\*\) END AS dropped_count/i);
  assert.match(up, /CASE WHEN d\.dropped_count >= 3 THEN d\.avg_drop_pct END/i);
  assert.match(up, /CASE WHEN ag\.priced_listings >= 3 THEN ag\.avg_asking END/i);
  assert.doesNotMatch(up, /ARRAY_AGG[\s\S]*agent_names/i);

  assert.match(up, /NULLIF\([^,]+\.address_key, ''\) IS NOT NULL/i);
  assert.doesNotMatch(up, /source \|\| ':' \|\| listing_id/i);
  assert.match(up, /JOIN property_listings pl ON pl\.id = e\.listing_pk[\s\S]*pl\.is_active/i);

  assert.match(down, /source \|\| ':' \|\| e\.listing_id/i);
  assert.match(down, /ARRAY_AGG\(DISTINCT a\)/i);
  assert.match(
    down,
    /WHERE listing_status = 'sold' AND price IS NOT NULL\s+GROUP BY region_code/i,
  );
});
