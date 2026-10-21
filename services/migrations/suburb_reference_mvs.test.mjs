import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { classify } from "../../scripts/prod-psql-classify.mjs";

// 000139 materializes what the suburb pages recomputed per request (DBP-01).
// It is hand-applied, and the API falls back to the live SQL until it is.

const up = readFileSync(new URL("./000139_suburb_reference_mvs.up.sql", import.meta.url), "utf8");
const down = readFileSync(new URL("./000139_suburb_reference_mvs.down.sql", import.meta.url), "utf8");
const code = up.replace(/--.*$/gm, "");
const views = ["mv_suburb_latest_price", "mv_housing_state_baselines", "mv_suburb_similarity_features"];

test("000139 applies as one transaction through db:prod:apply", () => {
  assert.deepEqual(classify(up), { verdict: "transaction", reason: "" });
  assert.match(code, /^\s*BEGIN;/);
  assert.match(code, /COMMIT;\s*$/);
  assert.match(code, /SET LOCAL statement_timeout = 0;/);
});

test("000139 is replay-safe: views are built only when absent, nothing is dropped", () => {
  for (const mv of views) {
    assert.match(code, new RegExp(`CREATE MATERIALIZED VIEW IF NOT EXISTS ${mv} AS`), `${mv} must be IF NOT EXISTS`);
  }
  assert.doesNotMatch(code, /\bDROP\b/i, "a replay must never rebuild a view");
  assert.doesNotMatch(code, /\bINSERT\s+INTO\b/i);
  assert.match(code, /CREATE OR REPLACE FUNCTION refresh_suburb_reference_views\(\)/);
});

test("every view has the unique index REFRESH ... CONCURRENTLY needs", () => {
  for (const [mv, column] of [
    ["mv_suburb_latest_price", "sal_code"],
    ["mv_housing_state_baselines", "state_code"],
    ["mv_suburb_similarity_features", "sal_code"],
  ]) {
    assert.match(code, new RegExp(`CREATE UNIQUE INDEX IF NOT EXISTS \\w+\\s+ON ${mv} \\(${column}\\);`), `${mv} unique index`);
  }
});

test("the licence gate reaches every price the views read", () => {
  // latest + prior in the price view, and the state median's latest pick.
  const gates = code.match(/source_licence <> 'proprietary-tos-restricted'/g) ?? [];
  assert.equal(gates.length, 3);
  assert.doesNotMatch(code, /property_listings|property_price_events/, "the reference views read no crawl table");
});

test("the refresh function guards each view: concurrent, blocking fallback, then a Skipping warning", () => {
  const fn = code.slice(code.indexOf("CREATE OR REPLACE FUNCTION refresh_suburb_reference_views()"), code.indexOf("ALTER FUNCTION"));
  for (const mv of views) {
    assert.match(fn, new RegExp(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${mv};`));
    assert.match(fn, new RegExp(`REFRESH MATERIALIZED VIEW ${mv};`));
    // scripts/prod-psql.sh refresh turns this line into a non-zero exit.
    assert.match(fn, new RegExp(`RAISE WARNING 'Skipping ${mv}: %'`));
  }
  assert.equal((fn.match(/EXCEPTION WHEN query_canceled OR OTHERS THEN/g) ?? []).length, 6);
  assert.match(code, /ALTER FUNCTION refresh_suburb_reference_views\(\) SET statement_timeout TO '0';/);
});

test("the refresh function returns the views it skipped, so the collector can fail its run", () => {
  // The collector's pool has no notice handler: a WARNING alone never reaches
  // its log or its exit code (house-price-collector/store.go).
  const fn = code.slice(code.indexOf("CREATE OR REPLACE FUNCTION refresh_suburb_reference_views()"), code.indexOf("ALTER FUNCTION"));
  assert.match(fn, /RETURNS text\[\]/);
  assert.match(fn, /skipped text\[\] := ARRAY\[\]::text\[\];/);
  for (const mv of views) {
    assert.match(
      fn,
      new RegExp(`RAISE WARNING 'Skipping ${mv}: %', SQLERRM;\\s*skipped := skipped \\|\\| \\('${mv}: ' \\|\\| SQLERRM\\);`),
      `a skipped ${mv} must be returned, not only warned about`,
    );
  }
  assert.match(fn, /RETURN skipped;\s*END;\s*\$\$;/);
});

test("the refresh records nothing in housing_mv_refresh, whose 72h sentinel these monthly views would trip", () => {
  assert.doesNotMatch(code, /housing_mv_refresh/);
});

test("000139 down drops the function before the views", () => {
  const dropFn = down.indexOf("DROP FUNCTION IF EXISTS refresh_suburb_reference_views();");
  assert.ok(dropFn > 0);
  for (const mv of views) {
    const dropView = down.indexOf(`DROP MATERIALIZED VIEW IF EXISTS ${mv};`);
    assert.ok(dropView > dropFn, `${mv} dropped after the function`);
  }
  assert.deepEqual(classify(down), { verdict: "transaction", reason: "" });
});
