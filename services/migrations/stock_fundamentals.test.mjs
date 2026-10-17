// node --test services/migrations/stock_fundamentals.test.mjs
//
// 000129 is in the deploy allowlist, so prod RE-RUNS it on every deploy. These
// assertions pin the properties that make that safe, the column contract the
// API stream codes against (docs/plans/stock-picker.md §2.1-2.2), and the
// growth guards that keep a non-finite number out of the view (the key_metrics
// ±Inf incident is why).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const up = readFileSync(new URL("./000129_add_stock_fundamentals.up.sql", import.meta.url), "utf8");
const down = readFileSync(new URL("./000129_add_stock_fundamentals.down.sql", import.meta.url), "utf8");
const workflow = readFileSync(
  new URL("../../.github/workflows/terraform-deploy.yml", import.meta.url),
  "utf8",
);

/** SQL with `--` comments removed, so prose never satisfies an assertion. */
const code = (sql) => sql.replace(/--.*$/gm, "");
const upCode = code(up);

/** The SELECT that defines a materialized view, up to WITH DATA. */
function viewBody(sql, name) {
  const start = sql.indexOf(`CREATE MATERIALIZED VIEW IF NOT EXISTS ${name} AS`);
  assert.ok(start >= 0, `${name} must be created with IF NOT EXISTS`);
  const end = sql.indexOf("WITH DATA;", start);
  assert.ok(end > start, `${name} must end WITH DATA`);
  return sql.slice(start, end);
}

/**
 * Output column names of the view's top-level SELECT, in order: the list is
 * split on commas at parenthesis depth 0, and each item's name is its alias
 * (`... AS name`) or, unaliased, the column it references (`c.stock_code`).
 */
function outputColumns(body) {
  const selectAt = body.search(/\n\)\s*\nSELECT\s*\n/);
  assert.ok(selectAt > 0, "expected a CTE followed by a top-level SELECT");
  const rest = code(body.slice(selectAt)).replace(/^\n\)\s*\nSELECT\s*\n/, "");
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

const PLAN_COLUMNS = [
  "stock_code",
  "basis_period_type",
  "latest_period_end",
  "latest_annual_period_end",
  "revenue_latest",
  "revenue_prior",
  "revenue_yoy_pct",
  "revenue_yoy_prior_pct",
  "eps_latest",
  "eps_prior",
  "eps_yoy_pct",
  "eps_yoy_prior_pct",
  "net_income_latest",
  "net_income_prior",
  "net_income_positive",
  "operating_cash_flow_latest",
  "revenue_ttm",
  "net_income_ttm",
  "eps_ttm",
  "revenue_half_delta",
  "net_income_half_delta",
  "currency",
  "periods_available",
  "fetched_at",
  // Half-year growth from filing rows (added 2026-09-27, appended so every
  // earlier column keeps its position).
  "revenue_half_yoy_pct",
  "net_income_half_yoy_pct",
  "eps_half_yoy_pct",
  "half_latest_period_end",
  "revenue_basis_period_type",
];

// ---------------------------------------------------------------------------
// replay safety

test("every CREATE is IF NOT EXISTS (replayed on every deploy)", () => {
  const creates = upCode.match(/\bCREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|MATERIALIZED\s+VIEW)\b[^;]*/gi) ?? [];
  assert.ok(creates.length >= 5, `expected the tables, indexes and view, found ${creates.length}`);
  for (const stmt of creates) {
    assert.match(stmt, /\bIF\s+NOT\s+EXISTS\b/i, `not replay-safe: ${stmt.slice(0, 80)}`);
  }
});

test("nothing is dropped, rewritten or inserted on replay", () => {
  assert.doesNotMatch(upCode, /\bDROP\b/i, "an allowlisted migration must not DROP anything");
  assert.doesNotMatch(upCode, /\bUPDATE\s+\w/i, "no row rewrites");
  assert.doesNotMatch(upCode, /\bDELETE\s+FROM\b/i, "no row deletes");
  assert.doesNotMatch(upCode, /\bINSERT\s+INTO\b/i, "no row inserts");
  assert.doesNotMatch(upCode, /\bADD\s+COLUMN\b/i, "no ALTER ... ADD COLUMN (fails on replay)");
  assert.doesNotMatch(upCode, /\bTRUNCATE\b/i);
});

test("the file is one transaction with the timeout disarmed in-session", () => {
  // Supavisor drops PGOPTIONS; only an in-session SET LOCAL takes effect, and
  // prod-psql's classifier accepts a single BEGIN ... COMMIT file.
  const stmts = upCode.split(";").map((s) => s.trim()).filter(Boolean);
  assert.equal(stmts[0], "BEGIN");
  assert.match(stmts[1], /^SET\s+LOCAL\s+statement_timeout\s*=\s*0$/i);
  assert.equal(stmts.at(-1), "COMMIT");
  assert.equal((upCode.match(/^\s*(BEGIN|COMMIT);/gim) ?? []).length, 2, "exactly one BEGIN and one COMMIT");
});

test("the deploy allowlist replays 000129 after 000095", () => {
  const hardening = workflow.indexOf("-f /migrations/000095_harden_mv_refresh.up.sql");
  const self = workflow.indexOf("-f /migrations/000129_add_stock_fundamentals.up.sql");
  assert.ok(hardening > 0, "000095 must stay in the allowlist");
  assert.ok(self > hardening, "000129 must be allowlisted AFTER 000095");
});

// ---------------------------------------------------------------------------
// schema contract (plan §2.1)

test("stock_fundamentals carries every plan column and the period_type check", () => {
  const table = up.slice(up.indexOf("CREATE TABLE IF NOT EXISTS stock_fundamentals ("));
  for (const col of [
    "stock_code",
    "period_type",
    "period_end",
    "fiscal_year",
    "currency",
    "revenue",
    "net_income",
    "eps_basic",
    "eps_diluted",
    "operating_cash_flow",
    "free_cash_flow",
    "shares_outstanding",
    "source",
    "source_fetched_at",
    "created_at",
    "updated_at",
  ]) {
    assert.match(table, new RegExp(`\\n\\s+${col}\\s+[A-Z]`), `missing column ${col}`);
  }
  assert.match(table, /PRIMARY KEY \(stock_code, period_type, period_end\)/);
  assert.match(table, /CHECK \(period_type IN \('annual','half','quarter','ttm'\)\)/);
});

test("non-finite and implausible values are refused by a CHECK on every value column", () => {
  const check = up.slice(up.indexOf("CONSTRAINT stock_fundamentals_finite_check"));
  for (const col of [
    "revenue",
    "net_income",
    "eps_basic",
    "eps_diluted",
    "operating_cash_flow",
    "free_cash_flow",
    "shares_outstanding",
  ]) {
    assert.match(
      check,
      new RegExp(`\\(${col}\\s+IS NULL OR ${col} = 0\\s+OR abs\\(${col}\\)\\s+BETWEEN 1e-12 AND 1e18\\)`),
      `${col} must be bounded (NaN and ±Infinity fail BETWEEN)`,
    );
  }
});

test("stock_fundamentals_sync has the plan's columns", () => {
  const table = up.slice(up.indexOf("CREATE TABLE IF NOT EXISTS stock_fundamentals_sync ("));
  for (const col of ["stock_code", "last_attempt_at", "last_success_at", "last_error", "periods_loaded"]) {
    assert.match(table, new RegExp(`\\n\\s+${col}\\s+[A-Z]`), `missing column ${col}`);
  }
});

// ---------------------------------------------------------------------------
// mv_fundamentals_growth (plan §2.2)

test("mv_fundamentals_growth exposes EXACTLY the plan's columns, in order", () => {
  assert.deepEqual(outputColumns(viewBody(up, "mv_fundamentals_growth")), PLAN_COLUMNS);
});

test("it has the unique index REFRESH ... CONCURRENTLY needs", () => {
  assert.match(
    upCode,
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_fundamentals_growth_stock_code\s+ON mv_fundamentals_growth \(stock_code\);/,
  );
});

test("every division in the view is behind a `> 0` CASE guard on its divisor", () => {
  const body = code(viewBody(up, "mv_fundamentals_growth"));
  const divisions = [...body.matchAll(/\/\s*([a-z0-9_]+\.[a-z_]+)/g)].map((m) => m[1]);
  assert.ok(divisions.length >= 11, `expected the growth ratios (6 vendor + 5 half), found ${divisions.length}`);
  for (const divisor of divisions) {
    const guard = new RegExp(`CASE WHEN ${divisor.replace(".", "\\.")} > 0\\b`);
    assert.match(body, guard, `division by ${divisor} must be guarded by CASE WHEN ${divisor} > 0`);
  }
  assert.doesNotMatch(body, /NULLIF\(/, "guard with > 0 (a negative prior is not a growth base either)");
});

test("growth is only computed within one currency", () => {
  const body = code(viewBody(up, "mv_fundamentals_growth"));
  for (const [latest, prior] of [
    ["a1", "a0"],
    ["a0", "am1"],
    ["e1", "e0"],
    ["e0", "em1"],
    ["ae1", "ae0"],
    ["ae0", "aem1"],
    ["h1", "h0"],
    ["h0", "hm1"],
  ]) {
    assert.match(body, new RegExp(`${latest}\\.currency = ${prior}\\.currency`), `${latest} vs ${prior}`);
  }
});

test("the prior point must be 10-14 months before the latest (same series a year earlier)", () => {
  const body = code(viewBody(up, "mv_fundamentals_growth"));
  const windows = body.match(/INTERVAL '14 months'\)::date\s+AND \([a-z0-9]+\.period_end - INTERVAL '10 months'\)/g) ?? [];
  assert.equal(windows.length, 8, "a0, am1, ae0, aem1, e0, em1, h0 and hm1 each need the 10-14 month window");
});

test("EPS basis is half when a fresher half pair exists, else ttm when a ttm pair exists, else annual", () => {
  const body = code(viewBody(up, "mv_fundamentals_growth"));
  assert.match(body, /CASE WHEN half_basis\.eps THEN 'half' WHEN eps_ttm_ok\.ok THEN 'ttm' ELSE 'annual' END/);
  assert.match(body, /e1\.period_end IS NOT NULL AND e0\.period_end IS NOT NULL/);
});

// ---------------------------------------------------------------------------
// half-year growth (filing rows)

test("half growth compares the latest half with the same half a year earlier", () => {
  const body = code(viewBody(up, "mv_fundamentals_growth"));
  // h1 is the latest 'half' row; h0 sits 10-14 months before it.
  assert.match(body, /WHERE f\.stock_code = c\.stock_code AND f\.period_type = 'half'\s+ORDER BY f\.period_end DESC\s+LIMIT 1\s+\) h1 ON true/);
  assert.match(body, /f\.period_type = 'half'\s+AND f\.period_end BETWEEN \(h1\.period_end - INTERVAL '14 months'\)::date\s+AND \(h1\.period_end - INTERVAL '10 months'\)::date[\s\S]*?\) h0 ON true/);
  for (const [col, divisor] of [
    ["revenue_yoy", "h0.revenue"],
    ["net_income_yoy", "h0.net_income"],
    ["eps_yoy", "he.prior"],
  ]) {
    const guard = new RegExp(
      `CASE WHEN ${divisor.replace(".", "\\.")} > 0 AND [a-z0-9_.]+ IS NOT NULL AND h1\\.currency = h0\\.currency\\s+THEN [^;]*?END\\s+AS ${col}\\b`,
    );
    assert.match(body, guard, `${col}: NULL unless the prior is > 0 and both halves share a currency`);
  }
  assert.match(body, /hg\.revenue_yoy\s+AS revenue_half_yoy_pct/);
  assert.match(body, /hg\.net_income_yoy\s+AS net_income_half_yoy_pct/);
  assert.match(body, /hg\.eps_yoy\s+AS eps_half_yoy_pct/);
  assert.match(body, /h1\.period_end\s+AS half_latest_period_end/);
});

test("half EPS never compares diluted with basic", () => {
  const body = code(viewBody(up, "mv_fundamentals_growth"));
  assert.match(
    body,
    /CASE WHEN h1\.eps_diluted IS NOT NULL AND h0\.eps_diluted IS NOT NULL THEN h1\.eps_diluted ELSE h1\.eps_basic END\s+AS latest/,
  );
  assert.match(
    body,
    /CASE WHEN h1\.eps_diluted IS NOT NULL AND h0\.eps_diluted IS NOT NULL THEN h0\.eps_diluted ELSE h0\.eps_basic END\s+AS prior/,
  );
});

test("the half basis wins only when its growth exists and the half is strictly newer", () => {
  const body = code(viewBody(up, "mv_fundamentals_growth"));
  assert.match(body, /hg\.revenue_yoy IS NOT NULL\s+AND \(a1\.period_end IS NULL OR h1\.period_end > a1\.period_end\)\) AS rev/);
  assert.match(body, /hg\.eps_yoy IS NOT NULL[\s\S]*?h1\.period_end > CASE WHEN eps_ttm_ok\.ok THEN e1\.period_end ELSE ae1\.period_end END\)\) AS eps/);
  // Each switched column moves as a set, so latest / prior / growth never mix bases.
  assert.match(body, /CASE WHEN half_basis\.rev THEN h1\.revenue ELSE a1\.revenue END\s+AS revenue_latest/);
  assert.match(body, /CASE WHEN half_basis\.rev THEN h0\.revenue ELSE a0\.revenue END\s+AS revenue_prior/);
  assert.match(body, /CASE WHEN half_basis\.rev THEN hg\.revenue_yoy\s+ELSE/);
  assert.match(body, /CASE WHEN half_basis\.rev THEN hg\.revenue_yoy_prior\s+ELSE/);
  assert.match(body, /CASE WHEN half_basis\.eps THEN he\.latest/);
  assert.match(body, /CASE WHEN half_basis\.eps THEN he\.prior/);
  assert.match(body, /CASE WHEN half_basis\.eps THEN hg\.eps_yoy\s+WHEN/);
  assert.match(body, /CASE WHEN half_basis\.eps THEN hg\.eps_yoy_prior\s+WHEN/);
  assert.match(body, /CASE WHEN half_basis\.eps THEN h1\.period_end/);
  assert.match(body, /CASE WHEN half_basis\.rev THEN 'half' ELSE 'annual' END::varchar\(8\)\s+AS revenue_basis_period_type/);
});

test("the in-place edit is flagged for databases that built the earlier view", () => {
  assert.match(up, /EDITED IN PLACE ONCE, 2026-09-27/);
  assert.match(up, /DROP MATERIALIZED VIEW mv_fundamentals_growth;` then re-apply this/);
});

test("half deltas need a ttm point one HALF after the latest annual, not a year after", () => {
  // TTM - FY is the half-on-pcp delta only when the TTM ends ~6 months after
  // the FY. At +12 months (Yahoo's small-cap annual lag) it is a full-year
  // change and must not be labelled a half.
  const body = code(viewBody(up, "mv_fundamentals_growth"));
  assert.match(body, /t1\.period_end BETWEEN \(a1\.period_end \+ INTERVAL '5 months'\)::date\s+AND \(a1\.period_end \+ INTERVAL '7 months'\)::date/);
  assert.match(body, /t1\.currency = a1\.currency/);
  assert.match(body, /CASE WHEN half_ok\.ok THEN t1\.revenue - a1\.revenue END\s+AS revenue_half_delta/);
  assert.match(body, /CASE WHEN half_ok\.ok THEN t1\.net_income - a1\.net_income END\s+AS net_income_half_delta/);
});

test("net_income_positive is a plain comparison (NULL when unknown, never coerced to false)", () => {
  const body = code(viewBody(up, "mv_fundamentals_growth"));
  assert.match(body, /\(a1\.net_income > 0\)\s+AS net_income_positive/);
  assert.doesNotMatch(body, /COALESCE\(\s*\(?a1\.net_income > 0/);
});

// ---------------------------------------------------------------------------
// down

test("down drops everything up creates", () => {
  const downCode = code(down);
  assert.match(downCode, /DROP MATERIALIZED VIEW IF EXISTS mv_fundamentals_growth;/);
  assert.match(downCode, /DROP TABLE IF EXISTS stock_fundamentals_sync;/);
  assert.match(downCode, /DROP TABLE IF EXISTS stock_fundamentals;/);
  assert.ok(
    downCode.indexOf("mv_fundamentals_growth") < downCode.indexOf("DROP TABLE IF EXISTS stock_fundamentals;"),
    "the view must go before the table it reads",
  );
});
