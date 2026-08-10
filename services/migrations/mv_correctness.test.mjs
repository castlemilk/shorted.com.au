import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const portalIDFallbackPattern =
  /\b(?:\w+\.)?source\b\s*\|\|\s*':'\s*\|\|\s*(?:\w+\.)?listing_id\b/i;
const localTimeoutRefreshPattern =
  /^\s*SET\s+LOCAL\s+statement_timeout\s*(?:=|TO)\s*0\s*;\s*SELECT\s+refresh_housing_materialized_views\(\)\s*;?\s*$/i;
const sessionTimeoutOverridePattern =
  /\bSET(?:\s+SESSION)?\s+statement_timeout\b/i;

function migration(number, direction) {
  const name = `${number}.${direction}.sql`;
  const url = new URL(`./${name}`, import.meta.url);
  assert.ok(existsSync(url), `${name} must exist`);
  return readFileSync(url, "utf8");
}

function refreshHousingMVCommand(store, description) {
  const body = store.match(
    /\bfunc\s+refreshHousingMV\b[^{]*\{([\s\S]*?)^\}/m,
  )?.[1];
  assert.ok(body, `${description} must define refreshHousingMV`);
  const command = body.match(
    /\bpool\.Exec\s*\(\s*ctx\s*,\s*`([\s\S]*?)`\s*\)/,
  )?.[1];
  assert.ok(command, `${description} must pass a raw SQL literal to pool.Exec`);
  return command;
}

test("portal-ID fallback guard recognizes aliased listing IDs", () => {
  assert.match("e.source || ':' || e.listing_id", portalIDFallbackPattern);
  assert.match("source || ':' || listing_id", portalIDFallbackPattern);
  assert.match("e.source||':'||e.listing_id", portalIDFallbackPattern);
  assert.match("e.source\n\t||\t':'\n||\te.listing_id", portalIDFallbackPattern);
  assert.doesNotMatch("datasource || ':' || listing_id", portalIDFallbackPattern);
  assert.doesNotMatch("source || ':' || listing_id_backup", portalIDFallbackPattern);
});

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

test("housing refresh timeout patterns distinguish local and session scope", async (t) => {
  const validLocal =
    "SET LOCAL statement_timeout = 0; SELECT refresh_housing_materialized_views()";
  const appendedSession =
    `${validLocal}; SET SESSION statement_timeout TO 0`;
  for (const [name, command] of [
    ["accepts SET LOCAL with equals", validLocal],
    [
      "accepts SET LOCAL with TO",
      "SET LOCAL statement_timeout TO 0; SELECT refresh_housing_materialized_views();",
    ],
  ]) {
    await t.test(name, () => {
      assert.match(command, localTimeoutRefreshPattern);
      assert.doesNotMatch(command, sessionTimeoutOverridePattern);
    });
  }
  for (const [name, command] of [
    [
      "rejects RESET LOCAL",
      "RESET LOCAL statement_timeout = 0; SELECT refresh_housing_materialized_views()",
    ],
    [
      "rejects FOOSET LOCAL",
      "FOOSET LOCAL statement_timeout = 0; SELECT refresh_housing_materialized_views()",
    ],
    [
      "rejects bare SET",
      "SET statement_timeout = 0; SELECT refresh_housing_materialized_views()",
    ],
    [
      "rejects SET SESSION",
      "SET SESSION statement_timeout = 0; SELECT refresh_housing_materialized_views()",
    ],
    ["rejects appended SET SESSION", appendedSession],
    [
      "rejects a comment decoy",
      `-- ${validLocal}\nSELECT 1`,
    ],
    ["rejects extra SQL", `${validLocal}; SELECT 1`],
  ]) {
    await t.test(name, () => {
      assert.doesNotMatch(command, localTimeoutRefreshPattern);
    });
  }
  for (const [name, command] of [
    ["detects bare SET", "SET statement_timeout = 0"],
    ["detects SET SESSION", "SET SESSION statement_timeout = 0"],
    ["detects appended SET SESSION with TO", appendedSession],
  ]) {
    await t.test(name, () => {
      assert.match(command, sessionTimeoutOverridePattern);
    });
  }
});

test("refreshHousingMV command extraction is scoped to its pool.Exec raw literal", () => {
  const command = refreshHousingMVCommand(
    `func unrelated(ctx context.Context, pool *pgxpool.Pool) error {
	_, err := pool.Exec(ctx, \`SET LOCAL statement_timeout = 0;\`)
	return err
}

func refreshHousingMV(ctx context.Context, pool *pgxpool.Pool) error {
	_, err := pool.Exec(ctx, \`SET SESSION statement_timeout = 0;
		SELECT refresh_housing_materialized_views()\`)
	return err
}

func later(ctx context.Context, pool *pgxpool.Pool) error {
	_, err := pool.Exec(ctx, \`SET LOCAL statement_timeout = 0;\`)
	return err
}`,
    "fixture",
  );
  assert.equal(
    command,
    "SET SESSION statement_timeout = 0;\n\t\tSELECT refresh_housing_materialized_views()",
  );
});

test("both housing collectors disable caller-side timeout transaction-locally before refreshing", async (t) => {
  for (const path of [
    "../house-price-collector/store.go",
    "../jobs/internal/jobs/houseprices/store.go",
  ]) {
    await t.test(path, () => {
      const store = readFileSync(new URL(path, import.meta.url), "utf8");
      const command = refreshHousingMVCommand(store, path);
      assert.match(
        command,
        localTimeoutRefreshPattern,
        `${path} must disarm the calling statement timeout for the transaction`,
      );
      assert.doesNotMatch(
        command,
        sessionTimeoutOverridePattern,
        `${path} must not leak a session-scoped timeout override`,
      );
    });
  }
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
  assert.equal(
    (up.match(/event_type IN \('first_seen', 'status_change', 'relisted'\)/gi) ?? [])
      .length,
    2,
    "both suburb and state sold windows must admit relisted sold markers",
  );
  assert.match(up, /listing_status = 'sold'/i);

  assert.match(up, /CASE WHEN[\s\S]*for_sale_priced[\s\S]*>= 3 THEN[\s\S]*avg_asking/i);
  assert.match(up, /CASE WHEN[\s\S]*sold_count[\s\S]*>= 3 THEN[\s\S]*avg_sold/i);
  assert.match(up, /COUNT\(\*\) AS dropped_count/i);
  assert.match(up, /COALESCE\(da\.dropped_count, 0\) AS dropped_count/i);
  assert.match(up, /'\{\}'::text\[\] AS agent_names/i);
  const suburbDropMV = up.match(
    /CREATE MATERIALIZED VIEW mv_suburb_price_drops AS([\s\S]*?)CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_suburb_price_drops_key/i,
  )?.[1];
  assert.ok(suburbDropMV, "suburb price-drop MV definition must be present");
  const suburbPerSource = suburbDropMV.match(
    /per_source AS\s*\(([\s\S]*?)\), win AS/i,
  )?.[1];
  const suburbWin = suburbDropMV.match(/win AS\s*\(([\s\S]*?)\), agg AS/i)?.[1];
  assert.ok(suburbPerSource, "suburb per-source aggregation must be present");
  assert.ok(suburbWin, "suburb winning-source selection must be present");
  assert.match(suburbPerSource, /MAX\(drop_abs\) AS max_abs/i);
  assert.match(
    suburbWin,
    /SELECT DISTINCT ON[\s\S]*\bmax_abs\b[\s\S]*FROM per_source/i,
  );
  assert.doesNotMatch(suburbDropMV, /NULL::double precision AS max_drop_pct/i);
  assert.doesNotMatch(suburbDropMV, /NULL::double precision AS max_drop_abs/i);
  assert.match(suburbDropMV, /MAX\(max_pct\) AS max_drop_pct/i);
  assert.match(suburbDropMV, /MAX\(max_abs\) AS max_drop_abs/i);
  assert.match(
    suburbDropMV,
    /CASE WHEN a\.dropped_listing_count >= 3 THEN a\.max_drop_pct END AS max_drop_pct/i,
  );
  assert.match(
    suburbDropMV,
    /CASE WHEN a\.dropped_listing_count >= 3 THEN a\.max_drop_abs END AS max_drop_abs/i,
  );
  assert.match(up, /CASE WHEN d\.dropped_count >= 3 THEN d\.avg_drop_pct END/i);
  assert.match(up, /CASE WHEN ag\.priced_listings >= 3 THEN ag\.avg_asking END/i);
  assert.doesNotMatch(up, /ARRAY_AGG[\s\S]*agent_names/i);

  assert.match(up, /NULLIF\([^,]+\.address_key, ''\) IS NOT NULL/i);
  assert.doesNotMatch(up, portalIDFallbackPattern);
  assert.match(up, /JOIN property_listings pl ON pl\.id = e\.listing_pk[\s\S]*pl\.is_active/i);

  assert.match(down, /source \|\| ':' \|\| e\.listing_id/i);
  assert.match(down, /ARRAY_AGG\(DISTINCT a\)/i);
  assert.match(
    down,
    /WHERE listing_status = 'sold' AND price IS NOT NULL\s+GROUP BY region_code/i,
  );
});

test("000109 deterministically chooses every address winner by listing ID", () => {
  const up = migration("000109_fix_listing_rollup_correctness", "up");
  const suburbListingMV = up.match(
    /CREATE MATERIALIZED VIEW mv_suburb_listing_stats AS([\s\S]*?)CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_suburb_listing_stats_key/i,
  )?.[1];
  const statePriceDropMV = up.match(
    /CREATE MATERIALIZED VIEW mv_state_price_drops AS([\s\S]*?)CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_state_price_drops_key/i,
  )?.[1];
  assert.ok(suburbListingMV, "suburb listing MV definition must be present");
  assert.ok(statePriceDropMV, "state price-drop MV definition must be present");

  const suburbAskingAddresses = suburbListingMV.match(
    /WITH asking_addresses AS\s*\(([\s\S]*?)\), fs AS/i,
  )?.[1];
  const suburbSoldAddresses = suburbListingMV.match(
    /sold_addresses AS\s*\(([\s\S]*?)\), sold AS/i,
  )?.[1];
  const stateActiveAddresses = statePriceDropMV.match(
    /active_addresses AS\s*\(([\s\S]*?)\), l AS/i,
  )?.[1];
  const stateSoldAddresses = statePriceDropMV.match(
    /sold_addresses AS\s*\(([\s\S]*?)\), sold AS/i,
  )?.[1];

  assert.ok(suburbAskingAddresses, "suburb asking-address CTE must be present");
  assert.ok(suburbSoldAddresses, "suburb sold-address CTE must be present");
  assert.ok(stateActiveAddresses, "state active-address CTE must be present");
  assert.ok(stateSoldAddresses, "state sold-address CTE must be present");
  assert.match(
    suburbAskingAddresses,
    /ORDER BY pl\.address_key, pl\.last_seen_at DESC, pl\.source, pl\.listing_id\s*$/im,
    "suburb asking winner must end with listing_id",
  );
  assert.match(
    suburbSoldAddresses,
    /ORDER BY pl\.address_key, st\.sold_at DESC, pl\.last_seen_at DESC, pl\.source, pl\.listing_id\s*$/im,
    "suburb sold winner must end with listing_id",
  );
  assert.match(
    stateActiveAddresses,
    /ORDER BY pl\.address_key, pl\.last_seen_at DESC, pl\.source, pl\.listing_id\s*$/im,
    "state active winner must end with listing_id",
  );
  assert.match(
    stateSoldAddresses,
    /ORDER BY pl\.address_key, st\.sold_at DESC, pl\.last_seen_at DESC, pl\.source, pl\.listing_id\s*$/im,
    "state sold winner must end with listing_id",
  );
});

test("000109 drives state rollups from active and recent sold addresses", () => {
  const up = migration("000109_fix_listing_rollup_correctness", "up");
  const statePriceDropMV = up.match(
    /CREATE MATERIALIZED VIEW mv_state_price_drops AS([\s\S]*?)CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_state_price_drops_key/i,
  )?.[1];
  assert.ok(statePriceDropMV, "state price-drop MV definition must be present");

  const soldAddresses = statePriceDropMV.match(
    /sold_addresses AS\s*\(([\s\S]*?)\), sold AS/i,
  )?.[1];
  const trackedAddresses = statePriceDropMV.match(
    /tracked_addresses AS\s*\(([\s\S]*?)\), u AS/i,
  )?.[1];
  const driver = statePriceDropMV.match(/u AS\s*\(([\s\S]*?)\)\s*SELECT/i)?.[1];
  assert.ok(soldAddresses, "state sold-address CTE must be present");
  assert.ok(trackedAddresses, "state tracked-address union must be present");
  assert.ok(driver, "state/AU address driver must be present");

  assert.match(
    soldAddresses,
    /pl\.state_code,\s*pl\.region_code,\s*pl\.address_key/i,
    "sold addresses must retain their suburb",
  );
  assert.match(
    trackedAddresses,
    /SELECT state_code, region_code, address_key\s+FROM active_addresses[\s\S]*UNION\s+SELECT state_code, region_code, address_key\s+FROM sold_addresses/i,
    "tracked addresses must deduplicate current-active and recent-sold populations",
  );
  assert.match(driver, /COUNT\(DISTINCT region_code\) AS suburbs_tracked/i);
  assert.match(driver, /GROUP BY GROUPING SETS \(\(state_code\), \(\)\)/i);
  assert.match(statePriceDropMV, /FROM u\s+LEFT JOIN l USING \(state_code\)/i);
  assert.match(
    statePriceDropMV,
    /COALESCE\(l\.total_active_listings, 0\) AS total_active_listings/i,
  );
  assert.match(
    statePriceDropMV,
    /COALESCE\(d\.dropped_count, 0\)::float\s*\/\s*NULLIF\(COALESCE\(l\.total_active_listings, 0\), 0\) AS dropped_share/i,
  );
  assert.match(statePriceDropMV, /u\.suburbs_tracked\s+FROM u/i);
});
