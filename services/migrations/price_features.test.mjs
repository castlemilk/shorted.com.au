// node --test services/migrations/price_features.test.mjs
//
// 000130 is in the deploy allowlist, so prod RE-RUNS it on every deploy. These
// assertions pin replay safety, the column contract the API stream codes
// against (docs/plans/stock-picker.md §2.3-2.5), the rules the plan fixes
// (60 sessions / 400 days / 260-session window, the breakout and base
// definitions, the regime ladder), and the 000095 guard pattern in
// refresh_strategy_views() — mirroring mv_refresh_hardening.test.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const up = readFileSync(new URL("./000130_add_price_features.up.sql", import.meta.url), "utf8");
const down = readFileSync(new URL("./000130_add_price_features.down.sql", import.meta.url), "utf8");
const workflow = readFileSync(
  new URL("../../.github/workflows/terraform-deploy.yml", import.meta.url),
  "utf8",
);

/** SQL with `--` comments removed, so prose never satisfies an assertion. */
const code = (sql) => sql.replace(/--.*$/gm, "");
const upCode = code(up);

function viewBody(sql, name) {
  const start = sql.indexOf(`CREATE MATERIALIZED VIEW IF NOT EXISTS ${name} AS`);
  assert.ok(start >= 0, `${name} must be created with IF NOT EXISTS`);
  const end = sql.indexOf("WITH DATA;", start);
  assert.ok(end > start, `${name} must end WITH DATA`);
  return code(sql.slice(start, end));
}

/**
 * Output column names of the view's top-level SELECT, in order: split on
 * commas at parenthesis depth 0; each item's name is its alias or, unaliased,
 * the column it references.
 */
function outputColumns(body) {
  const selectAt = body.search(/\n\)\s*\nSELECT\s*\n/);
  assert.ok(selectAt > 0, "expected a CTE followed by a top-level SELECT");
  const rest = body.slice(selectAt).replace(/^\n\)\s*\nSELECT\s*\n/, "");
  const list = rest.slice(0, rest.search(/\nFROM\s/));
  const items = [];
  let depth = 0;
  let cur = "";
  for (const ch of list) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      items.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  items.push(cur);
  return items.map((item) => {
    const text = item.trim();
    const alias = text.match(/\bAS\s+([a-z_0-9]+)$/i);
    if (alias) return alias[1];
    const ref = text.match(/^(?:[a-z_0-9]+\.)?([a-z_0-9]+)$/i);
    assert.ok(ref, `select item has neither an alias nor a plain column: ${text}`);
    return ref[1];
  });
}

const PRICE_FEATURE_COLUMNS = [
  "stock_code",
  "as_of",
  "close",
  "prev_close",
  "sma10",
  "sma20",
  "sma50",
  "sma150",
  "sma200",
  "sma200_1m_ago",
  "high_52w",
  "low_52w",
  "pct_off_52w_high",
  "pct_above_52w_low",
  "volume",
  "avg_volume_50d",
  "volume_ratio_50d",
  "dollar_volume_20d",
  "base_high",
  "base_low",
  "base_depth_pct",
  "base_length_days",
  "breakout_recent",
  "breakout_date",
  "ret_1m_pct",
  "ret_3m_pct",
  "ret_6m_pct",
  "ret_12m_pct",
  "rs_3m_pct",
  "rs_6m_pct",
  "sessions_available",
];

const REGIME_COLUMNS = [
  "index_code",
  "as_of",
  "close",
  "sma50",
  "sma200",
  "pct_off_52w_high",
  "ret_1m_pct",
  "ret_3m_pct",
  "regime",
];

// Cheapest first — the order refresh_strategy_views() refreshes them in.
const MVS = ["mv_market_regime", "mv_fundamentals_growth", "mv_price_features"];

// ---------------------------------------------------------------------------
// replay safety

test("every CREATE is IF NOT EXISTS or OR REPLACE (replayed on every deploy)", () => {
  const creates = upCode.match(/\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:UNIQUE\s+)?(?:TABLE|INDEX|MATERIALIZED\s+VIEW|FUNCTION)\b[^;]*/gi) ?? [];
  assert.ok(creates.length >= 5, `expected two views, two indexes and a function, found ${creates.length}`);
  for (const stmt of creates) {
    assert.match(stmt, /\bIF\s+NOT\s+EXISTS\b|\bOR\s+REPLACE\b/i, `not replay-safe: ${stmt.slice(0, 80)}`);
  }
});

test("no materialized view is dropped and no row is written on replay", () => {
  // Outside the function body (whose REFRESH statements only run when the job
  // calls it), nothing may drop or write.
  const outsideFunction = upCode.replace(/\$\$[\s\S]*?\$\$/g, "");
  assert.doesNotMatch(outsideFunction, /\bDROP\b/i, "an allowlisted migration must not DROP anything");
  assert.doesNotMatch(outsideFunction, /\bREFRESH\s+MATERIALIZED\s+VIEW\b/i, "replay must not refresh (the job does)");
  assert.doesNotMatch(upCode, /\bUPDATE\s+\w/i, "no row rewrites");
  assert.doesNotMatch(upCode, /\bDELETE\s+FROM\b/i, "no row deletes");
  assert.doesNotMatch(upCode, /\bINSERT\s+INTO\b/i, "no row inserts");
  assert.doesNotMatch(upCode, /\bADD\s+COLUMN\b/i);
  assert.doesNotMatch(upCode, /\bTRUNCATE\b/i);
});

test("the file is one transaction with the timeout disarmed in-session", () => {
  const outsideFunction = upCode.replace(/\$\$[\s\S]*?\$\$/g, "$$$$");
  const stmts = outsideFunction.split(";").map((s) => s.trim()).filter(Boolean);
  assert.equal(stmts[0], "BEGIN");
  assert.match(stmts[1], /^SET\s+LOCAL\s+statement_timeout\s*=\s*0$/i);
  assert.equal(stmts.at(-1), "COMMIT");
});

test("the DDL touches the views in the refresh function's lock order", () => {
  // CREATE UNIQUE INDEX IF NOT EXISTS locks its view before it sees the index
  // exists; the function holds its locks regime -> price features. The same
  // order here means an overlapping deploy waits instead of deadlocking.
  const regime = upCode.indexOf("CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_market_regime_index_code");
  const features = upCode.indexOf("CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_price_features_stock_code");
  assert.ok(regime > 0 && features > 0);
  assert.ok(regime < features, "mv_market_regime must be touched before mv_price_features");
});

test("the deploy allowlist replays 000130 after 000095 and after 000129", () => {
  const hardening = workflow.indexOf("-f /migrations/000095_harden_mv_refresh.up.sql");
  const fundamentals = workflow.indexOf("-f /migrations/000129_add_stock_fundamentals.up.sql");
  const self = workflow.indexOf("-f /migrations/000130_add_price_features.up.sql");
  assert.ok(hardening > 0, "000095 must stay in the allowlist");
  assert.ok(fundamentals > hardening, "000129 must be allowlisted AFTER 000095");
  assert.ok(self > fundamentals, "000130 must follow 000129 (its function refreshes 000129's view)");
});

// ---------------------------------------------------------------------------
// mv_price_features (plan §2.3)

test("mv_price_features exposes EXACTLY the plan's columns, in order", () => {
  assert.deepEqual(outputColumns(viewBody(up, "mv_price_features")), PRICE_FEATURE_COLUMNS);
});

test("it reads a date-bounded window, never the whole price table", () => {
  const body = viewBody(up, "mv_price_features");
  assert.match(body, /FROM stock_prices sp\s+WHERE sp\.date >= CURRENT_DATE - 400/);
  assert.equal((body.match(/\bFROM stock_prices\b/g) ?? []).length, 1, "exactly one scan of stock_prices");
});

test("only codes with >= 60 sessions, features over the trailing 260", () => {
  const body = viewBody(up, "mv_price_features");
  assert.match(body, /WHERE r\.n_sessions >= 60\s+AND r\.rn <= 260/);
});

test("averages require their full window (no short-history SMA)", () => {
  const body = viewBody(up, "mv_price_features");
  for (const n of [10, 20, 50, 150, 200]) {
    assert.match(
      body,
      new RegExp(`CASE WHEN count\\(\\*\\) FILTER \\(WHERE r\\.rn <= ${n}\\)\\s*= ${n}\\s+THEN avg\\(r\\.close\\) FILTER \\(WHERE r\\.rn <= ${n}\\)\\s*END\\s+AS sma${n}`),
      `sma${n} must be NULL without ${n} sessions`,
    );
  }
  assert.match(body, /count\(\*\) FILTER \(WHERE r\.rn BETWEEN 22 AND 221\) = 200/, "sma200_1m_ago needs 200 sessions");
});

test("the base is the 40 sessions before its anchor: the earliest recent breakout, else as_of", () => {
  // Without the anchor, the day after a breakout the prior-40 window holds the
  // breakout's own high and base_high (the API's invalidation level) jumps to
  // it: 10.30 reported against a real pivot of 9.80 on a scratch PG16.
  const body = viewBody(up, "mv_price_features");
  assert.match(body, /max\(px\.high\)\s+OVER \(w ROWS BETWEEN 40 PRECEDING AND 1 PRECEDING\)\s+AS prior40_high/);
  assert.match(
    body,
    /COALESCE\(max\(r\.rn\) FILTER \(WHERE r\.rn <= 5 AND r\.is_breakout\)\s+OVER \(PARTITION BY r\.stock_code\), 1\)\s+AS anchor_rn/,
    "anchor = the EARLIEST (largest rn) breakout in the last 5 sessions, else as_of",
  );
  assert.match(
    body,
    /max\(a\.prior40_high\) FILTER \(WHERE a\.rn = a\.anchor_rn AND a\.prior40_n = 40\)\s+OVER \(PARTITION BY a\.stock_code\)\s+AS pivot/,
    "the pivot is the anchor's prior-40 high: the level the breakout cleared",
  );
  assert.match(body, /max\(r\.pivot\)\s+AS base_high/);
  assert.match(body, /min\(r\.low\) FILTER \(WHERE r\.rn BETWEEN r\.anchor_rn \+ 1 AND r\.anchor_rn \+ 40\)/);
  assert.doesNotMatch(body, /FILTER \(WHERE r\.rn = 1 AND r\.prior40_n = 40\)\s+AS base_high/, "base_high must not float with as_of");
});

test("base_length_days counts from the EARLIEST session within 2% of the pivot", () => {
  // Counting back to the most recent touch read a flat base or an exact
  // retest (common with 2-decimal prices) as 1 session, failing the 20-session
  // minimum for every such stock.
  const body = viewBody(up, "mv_price_features");
  assert.match(
    body,
    /\(max\(r\.rn\) FILTER \(WHERE r\.rn BETWEEN r\.anchor_rn \+ 1 AND r\.anchor_rn \+ 40\s+AND r\.high >= 0\.98 \* r\.pivot\)\s+- max\(r\.anchor_rn\)\)::int\s+AS base_length_days/,
  );
  assert.doesNotMatch(body, /r\.high = r\.pivot/, "an exact-equality touch is the old, broken definition");
});

test("breakout_recent / breakout_date keep their meaning (the latest breakout)", () => {
  const body = viewBody(up, "mv_price_features");
  assert.match(body, /max\(r\.date\)\s+FILTER \(WHERE r\.rn <= 5 AND r\.is_breakout\)\s+AS breakout_date/);
});

test("a breakout is a close above the prior-40 high on >= 1.5x prior-50 volume, within 5 sessions", () => {
  const body = viewBody(up, "mv_price_features");
  assert.match(body, /s\.close > s\.prior40_high/);
  assert.match(body, /s\.volume >= 1\.5 \* s\.prior50_avg_volume/);
  assert.match(body, /avg\(px\.volume::float8\)\s+OVER \(w ROWS BETWEEN 50 PRECEDING AND 1 PRECEDING\)/);
  assert.match(body, /COALESCE\(bool_or\(r\.is_breakout\) FILTER \(WHERE r\.rn <= 5\), false\)\s+AS breakout_recent/);
  assert.match(body, /max\(r\.date\)\s+FILTER \(WHERE r\.rn <= 5 AND r\.is_breakout\)\s+AS breakout_date/);
});

test("relative strength is measured against XJO over the stock's own calendar window", () => {
  const body = viewBody(up, "mv_price_features");
  assert.equal((body.match(/ip\.index_code = 'XJO'/g) ?? []).length, 3, "XJO at as_of, the 3m anchor and the 6m anchor");
  assert.match(body, /ip\.date <= r\.d3m/);
  assert.match(body, /ip\.date <= r\.d6m/);
  assert.match(body, /r\.ret_3m_pct - \(x0\.close \/ x3\.close - 1\) \* 100\s+END\s+AS rs_3m_pct/);
  assert.match(body, /r\.ret_6m_pct - \(x0\.close \/ x6\.close - 1\) \* 100\s+END\s+AS rs_6m_pct/);
});

test("every division is behind a CASE guard on its divisor", () => {
  for (const name of ["mv_price_features", "mv_market_regime"]) {
    const body = viewBody(up, name);
    const divisions = [...body.matchAll(/\/\s*([a-z0-9_]+\.[a-z_0-9]+)/g)].map((m) => m[1]);
    assert.ok(divisions.length >= 3, `${name}: expected ratios, found ${divisions.length}`);
    for (const divisor of divisions) {
      const d = divisor.replace(".", "\\.");
      assert.match(body, new RegExp(`CASE WHEN[^;]*?${d}\\s*>\\s*0\\b`), `${name}: division by ${divisor} is unguarded`);
    }
  }
});

test("NaN / out-of-range prices never enter the window", () => {
  const body = viewBody(up, "mv_price_features");
  assert.match(body, /sp\.close > 0\s+AND sp\.close <= 99999999\.99/);
  const regime = viewBody(up, "mv_market_regime");
  assert.match(regime, /ip\.close > 0\s+AND ip\.close < 'Infinity'::float8/);
});

// ---------------------------------------------------------------------------
// mv_market_regime (plan §2.4)

test("mv_market_regime exposes EXACTLY the plan's columns, in order", () => {
  assert.deepEqual(outputColumns(viewBody(up, "mv_market_regime")), REGIME_COLUMNS);
});

test("one row per index_metadata code, regime ladder per plan §1", () => {
  const body = viewBody(up, "mv_market_regime");
  assert.match(body, /FROM index_metadata m\s+LEFT JOIN agg a ON a\.index_code = m\.index_code/);
  assert.match(body, /WHEN a\.close > a\.sma50 AND a\.sma50 > a\.sma200 THEN 'uptrend'/);
  assert.match(body, /WHEN a\.close > a\.sma200 THEN 'neutral'/);
  assert.match(body, /ELSE 'downtrend'/);
  assert.ok(body.indexOf("'uptrend'") < body.indexOf("'neutral'"), "uptrend is tested before neutral");
});

test("both views have the unique index REFRESH ... CONCURRENTLY needs", () => {
  assert.match(upCode, /CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_price_features_stock_code\s+ON mv_price_features \(stock_code\);/);
  assert.match(upCode, /CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_market_regime_index_code\s+ON mv_market_regime \(index_code\);/);
});

// ---------------------------------------------------------------------------
// refresh_strategy_views() — the 000095 pattern

function refreshSegments(sql) {
  const body = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION refresh_strategy_views()"));
  return body
    .split(/RAISE NOTICE 'Refreshing /)
    .slice(1)
    .map((segment) => segment.split(/RAISE NOTICE 'Strategy views refresh finished/)[0]);
}

test("every REFRESH is wrapped in its own exception guard, cheapest view first", () => {
  const segments = refreshSegments(up);
  assert.equal(segments.length, MVS.length);
  segments.forEach((segment, index) => {
    const mv = MVS[index];
    assert.match(segment, new RegExp(`^${mv}`), `segment ${index} should refresh ${mv}`);
    assert.match(
      segment,
      /BEGIN[\s\S]*REFRESH MATERIALIZED VIEW[\s\S]*EXCEPTION WHEN query_canceled OR OTHERS THEN[\s\S]*END;/,
      `${mv} refresh must be guarded`,
    );
    assert.match(segment, new RegExp(`RAISE WARNING 'Skipping ${mv}: %'`), `${mv} failure must degrade to a Skipping warning`);
  });
});

test("concurrent refreshes fall back to a non-concurrent retry", () => {
  for (const mv of MVS) {
    assert.match(up, new RegExp(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${mv};`), `${mv} concurrently first`);
    assert.match(up, new RegExp(`REFRESH MATERIALIZED VIEW ${mv};`), `${mv} non-concurrent fallback`);
  }
});

test("guards name query_canceled explicitly (WHEN OTHERS does not match 57014)", () => {
  assert.doesNotMatch(up, /EXCEPTION WHEN OTHERS THEN/, "no guard may rely on a bare WHEN OTHERS");
  const guards = (up.match(/EXCEPTION WHEN query_canceled OR OTHERS THEN/g) ?? []).length;
  assert.equal(guards, MVS.length * 2, "an inner (fallback) and an outer (skip) guard per view");
});

test("the function sets statement_timeout to 0 for its scope", () => {
  assert.match(up, /ALTER FUNCTION refresh_strategy_views\(\) SET statement_timeout TO '0';/);
});

test("it is a NEW function and leaves refresh_all_materialized_views() alone", () => {
  assert.doesNotMatch(upCode, /refresh_all_materialized_views/);
});

// ---------------------------------------------------------------------------
// down

test("down drops everything up creates, function first", () => {
  const downCode = code(down);
  const fn = downCode.indexOf("DROP FUNCTION IF EXISTS refresh_strategy_views();");
  const regime = downCode.indexOf("DROP MATERIALIZED VIEW IF EXISTS mv_market_regime;");
  const features = downCode.indexOf("DROP MATERIALIZED VIEW IF EXISTS mv_price_features;");
  assert.ok(fn >= 0 && regime >= 0 && features >= 0, "function and both views must be dropped");
  assert.ok(fn < regime && fn < features, "drop the function that names the views first");
  assert.doesNotMatch(downCode, /mv_fundamentals_growth/, "000129's view belongs to 000129's down");
});
