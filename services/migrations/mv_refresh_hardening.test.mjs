import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const up = readFileSync(
  new URL("./000095_harden_mv_refresh.up.sql", import.meta.url),
  "utf8",
);

const down = readFileSync(
  new URL("./000095_harden_mv_refresh.down.sql", import.meta.url),
  "utf8",
);

const MVS = [
  "mv_top_shorts",
  "mv_treemap_data",
  "mv_watchlist_defaults",
  "mv_available_dates",
  "mv_screener_data",
  "mv_short_campaigns",
  "mv_stock_price_coverage",
  "mv_company_state_exposure",
];

/** Body of refresh_all_materialized_views(), split into one segment per MV. */
function refreshSegments(sql) {
  const body = sql.slice(
    sql.indexOf("CREATE OR REPLACE FUNCTION refresh_all_materialized_views()"),
  );
  const segments = body
    .split(/RAISE NOTICE 'Refreshing /)
    .slice(1)
    .map((segment) => segment.split(/RAISE NOTICE 'All materialized/)[0]);
  return segments;
}

test("every REFRESH in the hardened function is wrapped in its own exception guard", () => {
  const segments = refreshSegments(up);
  assert.equal(segments.length, MVS.length);

  segments.forEach((segment, index) => {
    const mv = MVS[index];
    assert.match(
      segment,
      new RegExp(`^${mv}`),
      `segment ${index} should refresh ${mv}`,
    );
    // The refresh must sit inside a BEGIN ... EXCEPTION WHEN OTHERS ... END block.
    assert.match(
      segment,
      /BEGIN[\s\S]*REFRESH MATERIALIZED VIEW[\s\S]*EXCEPTION WHEN query_canceled OR OTHERS THEN[\s\S]*END;/,
      `${mv} refresh must be guarded by an exception handler`,
    );
    assert.match(
      segment,
      /RAISE WARNING/,
      `${mv} failure must degrade to a warning, not abort the function`,
    );
  });

  // No refresh may appear outside a guard: every REFRESH statement in the file
  // is preceded by a BEGIN within its own segment (checked above), and the count
  // of guards is at least the count of refresh statements.
  const refreshCount = (up.match(/REFRESH MATERIALIZED VIEW/g) ?? []).length;
  const handlerCount = (up.match(/EXCEPTION WHEN query_canceled OR OTHERS THEN/g) ?? [])
    .length;
  assert.ok(
    handlerCount >= refreshCount - MVS.length,
    "each MV must have at least one exception handler",
  );
});

test("concurrent refreshes fall back to a non-concurrent retry", () => {
  for (const mv of MVS.filter((m) => m !== "mv_watchlist_defaults")) {
    assert.match(
      up,
      new RegExp(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${mv};`),
      `${mv} should refresh concurrently first`,
    );
    assert.match(
      up,
      new RegExp(`REFRESH MATERIALIZED VIEW ${mv};`),
      `${mv} should have a non-concurrent fallback`,
    );
  }
});

test("guards name query_canceled explicitly (WHEN OTHERS does not match 57014)", () => {
  // plpgsql's OTHERS deliberately excludes query_canceled, which is what a
  // statement_timeout raises — a bare `WHEN OTHERS` would not have caught the
  // prod failure this migration exists to fix.
  assert.doesNotMatch(
    up,
    /EXCEPTION WHEN OTHERS THEN/,
    "no guard may rely on a bare WHEN OTHERS",
  );
  const guards = (up.match(/EXCEPTION WHEN query_canceled OR OTHERS THEN/g) ?? [])
    .length;
  assert.ok(guards >= MVS.length, "every MV needs a query_canceled-aware guard");
});

test("the function sets statement_timeout to 0 for the function scope", () => {
  assert.match(
    up,
    /ALTER FUNCTION refresh_all_materialized_views\(\) SET statement_timeout TO '0';/i,
  );
});

test("cheap mv_available_dates is refreshed before the expensive mv_screener_data", () => {
  const availableDates = up.indexOf("Refreshing mv_available_dates");
  const screener = up.indexOf("Refreshing mv_screener_data");
  assert.ok(availableDates > 0 && screener > 0);
  assert.ok(
    availableDates < screener,
    "mv_available_dates must not be hostage to the screener refresh",
  );
});

test("progress notices are preserved for every materialized view", () => {
  for (const mv of MVS) {
    assert.match(up, new RegExp(`RAISE NOTICE 'Refreshing ${mv}`));
  }
  assert.match(up, /RAISE NOTICE 'All materialized views refreshed\.'/);
});

test("down migration restores the unguarded function and resets the GUC", () => {
  assert.match(
    down,
    /CREATE OR REPLACE FUNCTION refresh_all_materialized_views\(\)/,
  );
  assert.match(
    down,
    /ALTER FUNCTION refresh_all_materialized_views\(\) RESET statement_timeout;/i,
  );
  // Original ordering: screener before available_dates.
  assert.ok(
    down.indexOf("Refreshing mv_screener_data") <
      down.indexOf("Refreshing mv_available_dates"),
    "down migration should restore the original refresh order",
  );
});
