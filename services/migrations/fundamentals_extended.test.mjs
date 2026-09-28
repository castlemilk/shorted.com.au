// node --test services/migrations/fundamentals_extended.test.mjs
//
// 000132 (docs/plans/fundamentals-coverage.md §2) is in the deploy allowlist,
// so prod re-runs it on every deploy, after 000129, 000130 and 000131. These
// pin the shape the plan fixes (§2.0: two transactions, lock order, both
// timeouts), what makes a replay a no-op (every add and index behind a catalog
// guard, the growth view dropped only while it lacks its last column), the
// column contracts the API and the job code against (§2.1, §2.3, §2.6, §2.7),
// and the guards that keep a non-finite or guessed number out of both views.
// The behaviour itself (the rebuild, the carry of owner and grants, every
// seeded case, and the refresh that overlaps the apply) is exercised against
// Postgres by services/jobs/internal/jobs/picks/migration132_pg_test.go.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { classify } from "../../scripts/prod-psql-classify.mjs";

const read = (name) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
const up = read("000132_extend_fundamentals.up.sql");
const down = read("000132_extend_fundamentals.down.sql");
const up129 = read("000129_add_stock_fundamentals.up.sql");
const up130 = read("000130_add_price_features.up.sql");
const workflow = readFileSync(new URL("../../.github/workflows/terraform-deploy.yml", import.meta.url), "utf8");

/** SQL with `--` comments removed, so prose never satisfies an assertion. */
const code = (sql) => sql.replace(/--.*$/gm, "");
const upCode = code(up);
const downCode = code(down);

/**
 * Top-level statements of comment-free SQL, split on `;` outside quotes and
 * dollar-quoted bodies. Each is { text, masked }: masked has every dollar body
 * replaced by `$$`, so a keyword inside a DO block or function body never
 * reads as a top-level statement.
 */
function statements(sql) {
  const out = [];
  let text = "";
  let masked = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'") {
      const end = sql.indexOf("'", i + 1);
      const j = end < 0 ? sql.length : end + 1;
      text += sql.slice(i, j);
      masked += sql.slice(i, j);
      i = j;
      continue;
    }
    const tag = ch === "$" ? sql.slice(i).match(/^\$[A-Za-z0-9_]*\$/) : null;
    if (tag) {
      const end = sql.indexOf(tag[0], i + tag[0].length);
      const j = end < 0 ? sql.length : end + tag[0].length;
      text += sql.slice(i, j);
      masked += "$$";
      i = j;
      continue;
    }
    if (ch === ";") {
      if (text.trim()) out.push({ text: text.trim(), masked: masked.trim() });
      text = "";
      masked = "";
      i++;
      continue;
    }
    text += ch;
    masked += ch;
    i++;
  }
  if (text.trim()) out.push({ text: text.trim(), masked: masked.trim() });
  return out;
}

/** The two transactions: [[stmt...], [stmt...]], BEGIN and COMMIT excluded. */
function transactions(sql) {
  const stmts = statements(code(sql));
  const txs = [];
  let cur = null;
  for (const s of stmts) {
    if (/^BEGIN$/i.test(s.masked)) {
      assert.equal(cur, null, "a BEGIN inside an open transaction");
      cur = [];
    } else if (/^COMMIT$/i.test(s.masked)) {
      assert.notEqual(cur, null, "a COMMIT with no open transaction");
      txs.push(cur);
      cur = null;
    } else {
      assert.notEqual(cur, null, `a statement outside a transaction: ${s.masked.slice(0, 80)}`);
      cur.push(s);
    }
  }
  assert.equal(cur, null, "the last transaction is committed");
  return txs;
}

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
 * (`... AS name`) or, unaliased, the column it references (`fb.revenue`).
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

/**
 * The body of a `LEFT JOIN LATERAL (...) alias ON true` in a view body: that
 * lateral's own text only, never the laterals before it (the body may not
 * span another `LEFT JOIN LATERAL`).
 */
function lateral(body, alias) {
  const m = body.match(new RegExp(`LEFT JOIN LATERAL \\(((?:(?!LEFT JOIN LATERAL)[\\s\\S])*?)\\n\\) ${alias} ON true`));
  assert.ok(m, `lateral ${alias} not found`);
  return m[1];
}

/** Every `/ divisor` in comment-free SQL must sit behind `CASE WHEN divisor > 0`. */
function assertDivisionsGuarded(body, minimum, label) {
  const divisions = [...body.matchAll(/\/\s*([a-z0-9_]+\.[a-z_0-9]+)/g)].map((m) => m[1]);
  assert.ok(divisions.length >= minimum, `${label}: expected at least ${minimum} divisions, found ${divisions.length}`);
  for (const divisor of divisions) {
    const guard = new RegExp(`CASE WHEN ${divisor.replace(".", "\\.")} > 0\\b`);
    assert.match(body, guard, `${label}: division by ${divisor} must be guarded by CASE WHEN ${divisor} > 0`);
  }
  const bare = [...body.matchAll(/\/\s*([0-9.]+|\()/g)].map((m) => m[1]);
  assert.deepEqual(bare.filter((d) => d !== "2"), [], `${label}: only the literal 2 (an average) may divide unguarded`);
  assert.doesNotMatch(body, /NULLIF\(/, `${label}: guard with > 0 (a negative denominator is not a base either)`);
}

// plan §2.1, in the plan's order.
const NEW_NUMERIC_COLUMNS = [
  "gross_profit",
  "operating_income",
  "ebitda",
  "normalized_ebitda",
  "ebit",
  "interest_expense",
  "pretax_income",
  "tax_provision",
  "net_interest_income",
  "capital_expenditure",
  "dividends_paid",
  "share_buybacks",
  "total_assets",
  "total_liabilities",
  "total_equity",
  "cash_and_equivalents",
  "total_debt",
  "capital_lease_obligations",
  "net_debt",
  "current_assets",
  "current_liabilities",
];

const ADDED_COLUMNS = [
  ...NEW_NUMERIC_COLUMNS.map((name) => ["stock_fundamentals", name, "DOUBLE PRECISION"]),
  ["stock_fundamentals", "field_sources", "JSONB NOT NULL DEFAULT ''{}''::jsonb"],
  ["stock_fundamentals", "source_document_url", "TEXT"],
  ["stock_fundamentals", "source_document_date", "DATE"],
  ["stock_fundamentals_sync", "last_outcome", "VARCHAR(16)"],
  ["stock_fundamentals_sync", "consecutive_empty", "SMALLINT NOT NULL DEFAULT 0"],
  ["stock_fundamentals_sync", "median_k", "DOUBLE PRECISION"],
  ["stock_fundamentals_sync", "fx_converted", "BOOLEAN"],
  ["stock_fundamentals_sync", "native_currency", "VARCHAR(8)"],
];

const GROWTH_APPENDED = [
  "revenue_basis_source",
  "eps_basis_source",
  "revenue_latest_period_end",
  "revenue_prior_period_end",
];

// plan §2.7, exactly.
const QUALITY_COLUMNS = [
  "stock_code", "basis_period_type", "basis_period_end", "currency", "source", "fetched_at",
  "revenue", "gross_profit", "operating_income", "ebitda", "normalized_ebitda", "ebit", "net_income",
  "operating_cash_flow", "operating_cash_flow_derived", "free_cash_flow", "capital_expenditure",
  "dividends_paid", "interest_expense", "shares_outstanding", "balance_period_end", "balance_period_type",
  "balance_currency", "balance_lag_months", "total_assets", "total_assets_prior", "total_liabilities",
  "total_equity", "total_equity_prior", "cash_and_equivalents", "total_debt", "capital_lease_obligations",
  "net_debt", "current_assets", "current_liabilities", "gross_margin_pct", "operating_margin_pct",
  "net_margin_pct", "fcf_margin_pct", "fcf_conversion", "roe_pct", "roa_pct", "net_debt_to_ebitda",
  "net_debt_to_equity", "current_ratio", "interest_cover", "payout_ratio_pct", "statement_is_financial",
];

// refresh_strategy_views() order (plan §2.8), which is also the DDL lock order.
const MVS = ["mv_market_regime", "mv_fundamentals_growth", "mv_fundamentals_quality", "mv_price_features"];

// ---------------------------------------------------------------------------
// shape and lock order (plan §2.0)

test("exactly two transactions, each disarming statement_timeout; the second bounds its lock waits", () => {
  const [tx1, tx2, ...rest] = transactions(up);
  assert.equal(rest.length, 0, "exactly two transactions");
  assert.match(tx1[0].masked, /^SET LOCAL statement_timeout = 0$/);
  assert.match(tx2[0].masked, /^SET LOCAL statement_timeout = 0$/);
  assert.match(tx2[1].masked, /^SET LOCAL lock_timeout = '15s'$/);
  assert.doesNotMatch(tx1.map((s) => s.masked).join("\n"), /lock_timeout/, "the function re-issue takes no relation lock to wait for");
});

test("transaction 1 only re-issues refresh_strategy_views(), so it commits before any relation lock", () => {
  const [tx1] = transactions(up);
  const heads = tx1.slice(1).map((s) => s.masked.split(/\s+/).slice(0, 4).join(" "));
  assert.deepEqual(heads, [
    "CREATE OR REPLACE FUNCTION",
    "ALTER FUNCTION refresh_strategy_views() SET",
    "COMMENT ON FUNCTION refresh_strategy_views()",
  ]);
});

test("transaction 2 touches the objects in refresh_strategy_views() order (plan §2.0 a-f)", () => {
  const [, tx2] = transactions(up);
  const find = (label, pred) => {
    const at = tx2.findIndex(pred);
    assert.ok(at >= 0, `${label} not found in transaction 2`);
    return at;
  };
  const isDo = (s) => /^DO \$\$$/.test(s.masked);
  const steps = [
    ["a. document_meta", (s) => isDo(s) && s.text.includes("document_meta")],
    ["b. picks_run_lease", (s) => /^CREATE TABLE IF NOT EXISTS picks_run_lease\b/.test(s.masked)],
    ["c. growth drop", (s) => isDo(s) && /DROP %s %I/.test(s.text)],
    ["d. column adds", (s) => isDo(s) && s.text.includes("ADD COLUMN IF NOT EXISTS %I %s")],
    ["d. v2 CHECK", (s) => isDo(s) && s.text.includes("stock_fundamentals_finite_check_v2")],
    ["e. growth view", (s) => /^CREATE MATERIALIZED VIEW IF NOT EXISTS mv_fundamentals_growth AS\b/.test(s.masked)],
    ["e. growth index", (s) => isDo(s) && s.text.includes("idx_mv_fundamentals_growth_stock_code")],
    ["f. quality view", (s) => /^CREATE MATERIALIZED VIEW IF NOT EXISTS mv_fundamentals_quality AS\b/.test(s.masked)],
    ["f. quality index", (s) => isDo(s) && s.text.includes("idx_mv_fundamentals_quality_stock_code")],
  ];
  const at = steps.map(([label, pred]) => [label, find(label, pred)]);
  for (let i = 1; i < at.length; i++) {
    assert.ok(at[i - 1][1] < at[i][1], `${at[i - 1][0]} must come before ${at[i][0]}`);
  }
  // Nothing else in transaction 2: every statement is one of the steps or a timeout.
  assert.equal(tx2.length, steps.length + 2);
});

test("prod-psql's classifier reads the file as `session` (two BEGIN ... COMMIT pairs)", () => {
  assert.equal(classify(up).verdict, "session");
  assert.equal(classify(down).verdict, "session");
});

// ---------------------------------------------------------------------------
// replay safety

test("every add, CHECK and index is behind a catalog guard inside a DO block", () => {
  const top = statements(upCode).map((s) => s.masked).join(";\n");
  assert.doesNotMatch(top, /\bADD\s+COLUMN\b/i, "no top-level ADD COLUMN");
  assert.doesNotMatch(top, /\bCREATE\s+(UNIQUE\s+)?INDEX\b/i, "no top-level CREATE INDEX (it locks the view before noticing the index exists)");
  assert.doesNotMatch(top, /\bADD\s+CONSTRAINT\b/i, "no top-level ADD CONSTRAINT");
  assert.doesNotMatch(top, /\bCOMMENT ON MATERIALIZED VIEW\b/i, "view COMMENTs only when the text differs");

  const bodies = statements(upCode).filter((s) => /^DO \$\$$/.test(s.masked)).map((s) => s.text);
  for (const body of bodies.filter((b) => /ADD COLUMN/.test(b))) {
    assert.match(body, /IF NOT EXISTS \(SELECT 1 FROM information_schema\.columns/, "column adds check information_schema.columns");
    assert.match(body, /ADD COLUMN IF NOT EXISTS/, "and stay IF NOT EXISTS");
  }
  const indexBodies = bodies.filter((b) => /CREATE UNIQUE INDEX/.test(b));
  assert.equal(indexBodies.length, 2, "one guarded unique index per view");
  for (const body of indexBodies) {
    assert.match(body, /IF NOT EXISTS \(SELECT 1 FROM pg_indexes/, "indexes check pg_indexes");
  }
  const check = bodies.find((b) => b.includes("stock_fundamentals_finite_check_v2"));
  assert.match(check, /IF NOT EXISTS \(SELECT 1 FROM pg_constraint/);
  assert.match(check, /\) NOT VALID\s/, "added NOT VALID");
  assert.match(check, /AND NOT convalidated\) THEN\s+EXECUTE 'ALTER TABLE stock_fundamentals VALIDATE CONSTRAINT stock_fundamentals_finite_check_v2'/, "then validated, only when not yet valid");
  assert.ok(check.indexOf("NOT VALID") < check.indexOf("VALIDATE CONSTRAINT"));
});

test("nothing reads, writes or rebuilds rows on replay", () => {
  const outsideBodies = statements(upCode).map((s) => s.masked).join(";\n");
  assert.doesNotMatch(upCode, /\bINSERT\s+INTO\b/i);
  assert.doesNotMatch(upCode, /\bUPDATE\s+\w+\s+SET\b/i);
  assert.doesNotMatch(upCode, /\bDELETE\s+FROM\b/i);
  assert.doesNotMatch(upCode, /\bTRUNCATE\b/i);
  assert.doesNotMatch(upCode, /\bCASCADE\b/i, "a cascade would drop dependents without a word");
  assert.doesNotMatch(outsideBodies, /\bREFRESH\s+MATERIALIZED\s+VIEW\b/i, "the job refreshes, never the deploy");
  assert.doesNotMatch(outsideBodies, /\bDROP\b/i, "the only DROP is the guarded one inside a DO block");
  const creates = outsideBodies.match(/\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|MATERIALIZED\s+VIEW|FUNCTION)\b[^;]*/gi) ?? [];
  assert.equal(creates.length, 4, "the lease table, two views, the function");
  for (const stmt of creates) {
    assert.match(stmt, /\bIF\s+NOT\s+EXISTS\b|\bOR\s+REPLACE\b/i, `not replay-safe: ${stmt.slice(0, 80)}`);
  }
});

test("the growth view is dropped only while it lacks the guard key, after naming any dependent", () => {
  const c = statements(upCode).find((s) => /DROP %s %I/.test(s.text)).text;
  assert.doesNotMatch(upCode, /DROP\s+MATERIALIZED\s+VIEW/i, "the drift guard rejects the literal statement in an allowlisted file");
  assert.match(c, /EXECUTE format\('DROP %s %I', 'MATERIALIZED VIEW', 'mv_fundamentals_growth'\)/);
  assert.match(c, /growth\s+oid := to_regclass\('mv_fundamentals_growth'\)/);
  assert.match(c, /IF growth IS NULL THEN\s+RETURN;/);
  assert.match(c, /FROM pg_attribute\s+WHERE attrelid = growth AND attname = 'revenue_prior_period_end' AND NOT attisdropped\) THEN\s+RETURN;/);
  const depend = c.indexOf("FROM pg_depend d");
  const raise = c.indexOf("RAISE EXCEPTION 'mv_fundamentals_growth cannot be rebuilt: %");
  const drop = c.indexOf("EXECUTE format('DROP %s %I'");
  assert.ok(depend > 0 && raise > depend && drop > raise, "dependents are named before anything is dropped");
  assert.match(c, /d\.refobjid = growth\s+AND d\.deptype = 'n'/);
  // What the rebuilt view carries over, as 000131 carries it.
  assert.match(c, /SELECT pg_get_userbyid\(c\.relowner\) AS owner, c\.reloptions, c\.relacl/);
  const e = statements(upCode).find((s) => /^DO \$\$$/.test(s.masked) && s.text.includes("idx_mv_fundamentals_growth_stock_code")).text;
  assert.match(e, /ALTER MATERIALIZED VIEW %I OWNER TO %I/);
  assert.match(e, /ALTER MATERIALIZED VIEW %I SET \(%s\)/);
  assert.match(e, /REVOKE ALL ON TABLE %I FROM %s/, "default-privilege grants on the new view are undone");
  assert.match(e, /GRANT %s ON TABLE %I TO %s%s/, "then the old view's grants are granted");
  assert.ok(e.indexOf("REVOKE ALL") < e.indexOf("GRANT %s"), "revoke before grant");
  assert.match(e, /aclexplode\(carry\.relacl\)/);
});

test("the growth COMMENT a 000129 replay rewrites is written back best effort, never failing a deploy", () => {
  const e = statements(upCode).find((s) => /^DO \$\$$/.test(s.masked) && s.text.includes("idx_mv_fundamentals_growth_stock_code")).text;
  assert.match(e, /IF obj_description\('mv_fundamentals_growth'::regclass, 'pg_class'\) IS DISTINCT FROM note THEN/);
  assert.match(e, /EXECUTE format\('COMMENT ON MATERIALIZED VIEW mv_fundamentals_growth IS %L', note\);\s+EXCEPTION WHEN lock_not_available THEN\s+RAISE NOTICE/);
});

// ---------------------------------------------------------------------------
// columns (plan §2.1, §2.3, §2.4, §2.5)

test("the column adds are exactly the plan's, in its order, with its types", () => {
  const body = statements(upCode).find((s) => s.text.includes("ADD COLUMN IF NOT EXISTS %I %s")).text;
  const tuples = [...body.matchAll(/\('([a-z_]+)',\s*'([a-z_]+)',\s*'((?:[^']|'')*)'\)/g)].map((m) => [m[1], m[2], m[3]]);
  assert.deepEqual(tuples, ADDED_COLUMNS);
  assert.match(body, /EXECUTE format\('ALTER TABLE %I ADD COLUMN IF NOT EXISTS %I %s', col\.tbl, col\.name, col\.typ\)/);
  assert.match(body, /table_schema = current_schema\(\)\s+AND table_name = col\.tbl\s+AND column_name = col\.name/);
});

test("the v2 CHECK bounds every new numeric column with 000129's form", () => {
  const body = statements(upCode).find((s) => s.text.includes("ADD CONSTRAINT stock_fundamentals_finite_check_v2")).text;
  const bounded = [...body.matchAll(/\(([a-z_]+)\s+IS NULL OR \1 = 0\s+OR abs\(\1\)\s+BETWEEN 1e-12 AND 1e18\)/g)].map((m) => m[1]);
  assert.deepEqual(bounded, NEW_NUMERIC_COLUMNS);
});

test("document_meta, picks_run_lease and the sync columns are the plan's", () => {
  const a = statements(upCode).find((s) => /^DO \$\$$/.test(s.masked) && s.text.includes("document_meta")).text;
  assert.match(a, /ALTER TABLE financial_report_extractions ADD COLUMN IF NOT EXISTS document_meta JSONB/);
  assert.match(a, /IF to_regclass\('financial_report_extractions'\) IS NULL THEN/, "a database without the table is not an error");
  assert.match(
    upCode,
    /CREATE TABLE IF NOT EXISTS picks_run_lease \(\s+name\s+TEXT\s+PRIMARY KEY,\s+holder\s+TEXT\s+NOT NULL,\s+expires_at TIMESTAMPTZ NOT NULL\s+\);/,
  );
});

// ---------------------------------------------------------------------------
// mv_fundamentals_growth (plan §2.6)

const growth = code(viewBody(up, "mv_fundamentals_growth"));

test("growth: 000129's columns as a prefix, then the four appended, the guard key last", () => {
  const before = outputColumns(viewBody(up129, "mv_fundamentals_growth"));
  const after = outputColumns(viewBody(up, "mv_fundamentals_growth"));
  assert.deepEqual(after, [...before, ...GROWTH_APPENDED]);
  assert.equal(after.at(-1), "revenue_prior_period_end", "the guard key is the CREATE's last column");
  assert.match(growth, /CASE WHEN rb\.yoy IS NOT NULL THEN rb\.prior_end END\s+AS revenue_prior_period_end\s*\nFROM codes c/);
});

test("growth: every lateral filters on the field it reads; quarter rows are never read", () => {
  for (const alias of ["a1", "a0", "am1"]) {
    assert.match(lateral(growth, alias), /f\.period_type = 'annual' AND f\.revenue IS NOT NULL/, alias);
  }
  for (const alias of ["n1", "n0"]) {
    assert.match(lateral(growth, alias), /f\.period_type = 'annual' AND f\.net_income IS NOT NULL/, alias);
  }
  for (const alias of ["ae1", "ae0", "aem1"]) {
    assert.match(lateral(growth, alias), /f\.period_type = 'annual' AND f\.eps_diluted IS NOT NULL/, alias);
  }
  for (const alias of ["e1", "e0", "em1"]) {
    assert.match(lateral(growth, alias), /f\.period_type = 'ttm' AND f\.eps_diluted IS NOT NULL/, alias);
  }
  assert.match(lateral(growth, "t1"), /f\.period_type = 'ttm'\s+AND \(f\.revenue IS NOT NULL OR f\.net_income IS NOT NULL\)/);
  assert.match(lateral(growth, "tr1"), /f\.period_type = 'ttm' AND f\.revenue IS NOT NULL/);
  for (const alias of ["h1", "h0", "hm1"]) {
    assert.match(
      lateral(growth, alias),
      /f\.period_type = 'half'\s+AND \(f\.revenue IS NOT NULL OR f\.net_income IS NOT NULL OR f\.eps_basic IS NOT NULL OR f\.eps_diluted IS NOT NULL\)/,
      alias,
    );
  }
  assert.doesNotMatch(growth, /'quarter'/, "no lateral reads a balance snapshot");
  // periods_available counts rows carrying any flow field.
  assert.match(growth, /WHERE f\.period_type IN \('annual', 'half', 'ttm'\)\s+AND num_nonnulls\(f\.revenue, f\.net_income, f\.eps_basic, f\.eps_diluted, f\.operating_cash_flow, f\.free_cash_flow,/);
  // The profit series and the EPS series read their own laterals.
  assert.match(growth, /n1\.net_income\s+AS net_income_latest/);
  assert.match(growth, /n0\.net_income\s+AS net_income_prior/);
  assert.match(growth, /\(n1\.net_income > 0\)\s+AS net_income_positive/);
  assert.match(growth, /e1\.eps_diluted\s+AS eps_ttm/);
});

test("growth: a fresher TTM revenue point uses a comparator 12 months +/- 7 days earlier, TTM before annual", () => {
  for (const [alias, anchor] of [["rc", "tr1"], ["rp", "rc"]]) {
    const body = lateral(growth, alias);
    assert.match(body, /f\.period_type IN \('ttm', 'annual'\)/, alias);
    assert.match(body, new RegExp(`f\\.revenue > 0 AND f\\.currency = ${anchor}\\.currency`), `${alias}: same currency, value > 0`);
    assert.match(
      body,
      new RegExp(
        `f\\.period_end BETWEEN \\(${anchor}\\.period_end - INTERVAL '12 months' - INTERVAL '7 days'\\)::date\\s+AND \\(${anchor}\\.period_end - INTERVAL '12 months' \\+ INTERVAL '7 days'\\)::date`,
      ),
      `${alias}: 12 months +/- 7 days`,
    );
    assert.match(body, /ORDER BY \(f\.period_type = 'ttm'\) DESC/, `${alias}: a TTM row is preferred to an annual one`);
  }
  assert.match(growth, /\(tr1\.period_end IS NOT NULL AND rc\.period_end IS NOT NULL\s+AND \(a1\.period_end IS NULL OR tr1\.period_end > a1\.period_end\)\) AS ok\s+\) rev_ttm/);
  // The half still wins when it is strictly the newest point.
  assert.match(growth, /AND \(a1\.period_end IS NULL OR h1\.period_end > a1\.period_end\)\s+AND \(NOT rev_ttm\.ok OR h1\.period_end > tr1\.period_end\)\) AS rev/);
  assert.match(growth, /CASE WHEN half_basis\.rev THEN 'half' WHEN rev_ttm\.ok THEN 'ttm' ELSE 'annual' END AS basis/);
  // Latest / prior / growth / period ends / currency / marks move as one set.
  for (const [col, half, ttm, annual] of [
    ["latest", "h1.revenue", "tr1.revenue", "a1.revenue"],
    ["prior", "h0.revenue", "rc.revenue", "a0.revenue"],
    ["latest_end", "h1.period_end", "tr1.period_end", "a1.period_end"],
    ["prior_end", "h0.period_end", "rc.period_end", "a0.period_end"],
    ["currency", "h1.currency", "tr1.currency", "a1.currency"],
  ]) {
    const esc = (s) => s.replace(".", "\\.");
    assert.match(
      growth,
      new RegExp(`CASE WHEN half_basis\\.rev THEN ${esc(half)} WHEN rev_ttm\\.ok THEN ${esc(ttm)} ELSE ${esc(annual)} END AS ${col}\\b`),
      col,
    );
  }
  // On the TTM basis the prior growth is rc vs rp, never the annual acceleration.
  assert.match(growth, /WHEN rev_ttm\.ok THEN\s+CASE WHEN rp\.revenue > 0 AND rc\.revenue IS NOT NULL AND rc\.currency = rp\.currency\s+THEN \(rc\.revenue - rp\.revenue\) \/ rp\.revenue \* 100 END/);
  assert.match(growth, /CASE WHEN rb\.yoy IS NOT NULL THEN rb\.latest_end END\s+AS revenue_latest_period_end/);
});

test("growth: basis source is 'filing' when either row, or the field it used, came from a filing", () => {
  assert.match(growth, /WHEN 'asx-filing-extraction' = ANY \(rb\.marks\) THEN 'filing'\s+ELSE 'vendor' END::varchar\(8\)\s+AS revenue_basis_source/);
  assert.match(growth, /WHEN 'asx-filing-extraction' = ANY \(eb\.marks\) THEN 'filing'\s+ELSE 'vendor' END::varchar\(8\)\s+AS eps_basis_source/);
  assert.match(growth, /THEN ARRAY\[h1\.source, h0\.source, h1\.field_sources ->> 'revenue', h0\.field_sources ->> 'revenue'\]/);
  assert.match(growth, /THEN ARRAY\[tr1\.source, rc\.source, tr1\.field_sources ->> 'revenue', rc\.field_sources ->> 'revenue'\]/);
  assert.match(growth, /ELSE ARRAY\[a1\.source, a0\.source, a1\.field_sources ->> 'revenue', a0\.field_sources ->> 'revenue'\]/);
  // The EPS marks read the column the EPS basis used (half: diluted only when both halves carry it).
  assert.match(growth, /THEN ARRAY\[h1\.source, h0\.source, h1\.field_sources ->> he\.col, h0\.field_sources ->> he\.col\]/);
  assert.match(growth, /CASE WHEN h1\.eps_diluted IS NOT NULL AND h0\.eps_diluted IS NOT NULL THEN 'eps_diluted' ELSE 'eps_basic' END\s+AS col/);
  assert.match(growth, /THEN ARRAY\[e1\.source, e0\.source, e1\.field_sources ->> 'eps_diluted', e0\.field_sources ->> 'eps_diluted'\]/);
  assert.match(growth, /ELSE ARRAY\[ae1\.source, ae0\.source, ae1\.field_sources ->> 'eps_diluted', ae0\.field_sources ->> 'eps_diluted'\]/);
});

test("growth: every division is guarded and growth stays within one currency", () => {
  assertDivisionsGuarded(growth, 13, "mv_fundamentals_growth");
  for (const [latest, prior] of [
    ["a1", "a0"],
    ["a0", "am1"],
    ["e1", "e0"],
    ["e0", "em1"],
    ["ae1", "ae0"],
    ["ae0", "aem1"],
    ["h1", "h0"],
    ["h0", "hm1"],
    ["tr1", "rc"],
    ["rc", "rp"],
  ]) {
    assert.match(growth, new RegExp(`${latest}\\.currency = ${prior}\\.currency`), `${latest} vs ${prior}`);
  }
});

// ---------------------------------------------------------------------------
// mv_fundamentals_quality (plan §2.7)

const quality = code(viewBody(up, "mv_fundamentals_quality"));

test("quality: exactly the plan's columns, in order, reading stock_fundamentals only", () => {
  assert.deepEqual(outputColumns(viewBody(up, "mv_fundamentals_quality")), QUALITY_COLUMNS);
  const sources = [...quality.matchAll(/\bFROM\s+([a-z_"]+)(?=\s)/gi)].map((m) => m[1]);
  assert.deepEqual([...new Set(sources)].sort(), ["codes", "stock_fundamentals"], "no prices, no company metadata");
  assert.match(upCode, /CREATE UNIQUE INDEX idx_mv_fundamentals_quality_stock_code ON mv_fundamentals_quality \(stock_code\)/);
});

test("quality: ONE flow row, the freshest ttm/annual with revenue and profit, the fuller row on a tie", () => {
  const fb = lateral(quality, "fb");
  assert.match(fb, /f\.period_type IN \('ttm', 'annual'\)\s+AND f\.revenue IS NOT NULL AND f\.net_income IS NOT NULL/);
  assert.match(fb, /ORDER BY f\.period_end DESC,\s+num_nonnulls\(/);
  assert.match(fb, /\(f\.period_type = 'annual'\) DESC\s+LIMIT 1/);
  // Every flow line and flow ratio reads fb.
  for (const col of ["revenue", "gross_profit", "operating_income", "ebitda", "normalized_ebitda", "ebit", "net_income",
    "operating_cash_flow", "free_cash_flow", "capital_expenditure", "dividends_paid", "interest_expense"]) {
    assert.match(quality, new RegExp(`\\n\\s+fb\\.${col},\\n`), col);
  }
});

test("quality: the balance row matches the flow currency, on or up to 6 months BEFORE the flow date", () => {
  const bb = lateral(quality, "bb");
  assert.match(bb, /f\.period_type IN \('annual', 'half', 'quarter'\)/);
  assert.match(bb, /f\.total_equity IS NOT NULL AND f\.currency = fb\.currency/);
  assert.match(bb, /f\.period_end <= fb\.period_end\s+AND f\.period_end >= \(fb\.period_end - INTERVAL '6 months'\)::date/, "never after");
  const bp = lateral(quality, "bp");
  assert.match(bp, /f\.currency = bb\.currency/);
  assert.match(bp, /BETWEEN \(bb\.period_end - INTERVAL '14 months'\)::date\s+AND \(bb\.period_end - INTERVAL '10 months'\)::date/);
  assert.match(quality, /bp\.total_equity\s+AS total_equity_prior/);
  assert.match(quality, /bp\.total_assets\s+AS total_assets_prior/);
  assert.match(quality, /CASE WHEN bb\.period_end IS NOT NULL\s+THEN \(\(extract\(year FROM fb\.period_end\) \* 12 \+ extract\(month FROM fb\.period_end\)\)/);
});

test("quality: every definition in plan §2.7", () => {
  assertDivisionsGuarded(quality, 12, "mv_fundamentals_quality");
  // Net debt excluding leases: stored, else debt - leases - cash, never debt - cash.
  assert.match(quality, /COALESCE\(bb\.net_debt, bb\.total_debt - bb\.capital_lease_obligations - bb\.cash_and_equivalents\) AS net_debt/);
  assert.doesNotMatch(quality, /total_debt - bb\.cash_and_equivalents/);
  assert.match(quality, /COALESCE\(fb\.normalized_ebitda, fb\.ebitda\)\s+AS ebitda_basis/);
  // ROE / ROA: both points > 0, averaged; ROE not meaningful under 10% equity / assets.
  assert.match(quality, /CASE WHEN bb\.total_equity > 0 AND bp\.total_equity > 0\s+THEN \(bb\.total_equity \+ bp\.total_equity\) \/ 2 END\s+AS avg_equity/);
  assert.match(quality, /CASE WHEN bb\.total_assets > 0 AND bp\.total_assets > 0\s+THEN \(bb\.total_assets \+ bp\.total_assets\) \/ 2 END\s+AS avg_assets/);
  assert.match(quality, /CASE WHEN x\.avg_equity > 0 AND x\.avg_assets > 0 AND x\.avg_equity >= 0\.1 \* x\.avg_assets\s+THEN fb\.net_income \/ x\.avg_equity \* 100 END\s+AS roe_pct/);
  assert.match(quality, /CASE WHEN x\.avg_assets > 0 THEN fb\.net_income \/ x\.avg_assets \* 100 END\s+AS roa_pct/);
  // Margins, conversion, leverage, liquidity, cover, payout.
  for (const [line, col] of [["gross_profit", "gross_margin_pct"], ["operating_income", "operating_margin_pct"],
    ["net_income", "net_margin_pct"], ["free_cash_flow", "fcf_margin_pct"]]) {
    assert.match(quality, new RegExp(`CASE WHEN fb\\.revenue > 0 THEN fb\\.${line} / fb\\.revenue \\* 100 END\\s+AS ${col}`), col);
  }
  assert.match(quality, /CASE WHEN fb\.net_income > 0 THEN fb\.free_cash_flow \/ fb\.net_income END\s+AS fcf_conversion/);
  assert.match(quality, /CASE WHEN x\.ebitda_basis > 0 THEN x\.net_debt \/ x\.ebitda_basis END\s+AS net_debt_to_ebitda/);
  assert.match(quality, /CASE WHEN bb\.total_equity > 0 THEN x\.net_debt \/ bb\.total_equity END\s+AS net_debt_to_equity/);
  assert.match(quality, /CASE WHEN bb\.current_liabilities > 0 THEN bb\.current_assets \/ bb\.current_liabilities END AS current_ratio/);
  assert.match(quality, /CASE WHEN fb\.interest_expense > 0 THEN fb\.operating_income \/ fb\.interest_expense END\s+AS interest_cover/);
  assert.match(quality, /CASE WHEN fb\.net_income > 0 AND fb\.dividends_paid <= 0\s+THEN abs\(fb\.dividends_paid\) \/ fb\.net_income \* 100 END\s+AS payout_ratio_pct/);
  assert.match(quality, /COALESCE\(fb\.field_sources ->> 'operating_cash_flow', ''\) = 'derived:fcf-minus-capex'\) AS operating_cash_flow_derived/);
});

test("quality: statement_is_financial reads the newest FULL Yahoo statement, never the flow row", () => {
  // Legacy (000129-shaped), Markit, filing and gate-refused rows never carry
  // operating income or EBITDA, whatever the company is; reading them as a
  // bank withheld BHP's, CSL's and FMG's ratios. NULL (unknown) instead.
  assert.match(
    quality,
    /CASE WHEN shape\.period_end IS NOT NULL\s+THEN \(shape\.operating_income IS NULL AND shape\.ebitda IS NULL\) END\s+AS statement_is_financial/,
  );
  assert.doesNotMatch(quality, /fb\.operating_income IS NULL|fb\.ebitda IS NULL/, "the flow row never decides the shape");
  const shape = lateral(quality, "shape");
  assert.match(shape, /^\s*SELECT f\.period_end, f\.operating_income, f\.ebitda\s+FROM stock_fundamentals f\s+WHERE f\.stock_code = c\.stock_code/);
  assert.match(shape, /f\.period_type IN \('annual', 'ttm'\)/);
  assert.match(shape, /f\.source = 'yahoo-timeseries'/, "only the vendor's own statement (never Markit or a filing)");
  assert.match(shape, /f\.pretax_income IS NOT NULL/, "a full statement: Yahoo publishes PretaxIncome for banks and insurers too");
  assert.match(
    shape,
    /\(f\.field_sources -> 'revenue'\) IS NULL AND \(f\.field_sources -> 'net_income'\) IS NULL/,
    "revenue and net income are the row's own, not filled from another source",
  );
  assert.match(shape, /ORDER BY f\.period_end DESC,\s+\(f\.period_type = 'annual'\) DESC\s+LIMIT 1\s*$/, "the newest; the annual on a tie");
  assert.doesNotMatch(shape, /\bfb\./, "independent of the flow row");
  assert.doesNotMatch(shape, /\?/, "no jsonb ? operator: a client that binds ? as a placeholder must still run the file");
  // The view's COMMENT says the same.
  const f = statements(upCode).find((s) => /^DO \$\$$/.test(s.masked) && s.text.includes("idx_mv_fundamentals_quality_stock_code")).text;
  assert.match(f, /statement_is_financial reads the newest full Yahoo income statement/);
  assert.match(f, /NULL when no such statement is held/);
  assert.doesNotMatch(f, /flags a flow row/);
});

// ---------------------------------------------------------------------------
// refresh_strategy_views() (plan §2.8)

function refreshSegments(sql) {
  const body = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION refresh_strategy_views()"));
  return body
    .split(/RAISE NOTICE 'Refreshing /)
    .slice(1)
    .map((segment) => segment.split(/RAISE NOTICE 'Strategy views refresh finished/)[0]);
}

test("the function refreshes the four views in lock order, each guarded, then sets its timeout", () => {
  const segments = refreshSegments(up);
  assert.equal(segments.length, MVS.length);
  segments.forEach((segment, index) => {
    const mv = MVS[index];
    assert.match(segment, new RegExp(`^${mv}`), `segment ${index} should refresh ${mv}`);
    assert.match(segment, new RegExp(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${mv};`));
    assert.match(segment, new RegExp(`REFRESH MATERIALIZED VIEW ${mv};`), `${mv} non-concurrent fallback`);
    assert.match(segment, new RegExp(`RAISE WARNING 'Skipping ${mv}: %'`));
  });
  assert.doesNotMatch(up, /EXCEPTION WHEN OTHERS THEN/, "no guard may rely on a bare WHEN OTHERS (57014)");
  assert.equal((up.match(/EXCEPTION WHEN query_canceled OR OTHERS THEN/g) ?? []).length, MVS.length * 2);
  const [tx1] = transactions(up);
  assert.match(tx1.at(-2).masked, /^ALTER FUNCTION refresh_strategy_views\(\) SET statement_timeout TO '0'$/, "the ALTER FUNCTION trails the body");
  assert.doesNotMatch(upCode, /refresh_all_materialized_views/);
});

// ---------------------------------------------------------------------------
// the deploy allowlist (plan §2, §9 step 1)

test("the deploy applies 000132 on the session pooler, right after 000131, with the never-remove note", () => {
  const line = "run_psql_session -f /migrations/000132_extend_fundamentals.up.sql";
  const self = workflow.indexOf(line);
  const w131 = workflow.indexOf("run_psql_session -f /migrations/000131_widen_stock_price_precision.up.sql");
  assert.ok(w131 > 0, "000131 stays in the deploy");
  assert.ok(self > w131, "000132 is applied AFTER 000131");
  assert.equal(workflow.indexOf(line, self + 1), -1, "applied once per deploy");
  assert.equal(workflow.match(/-f \/migrations\/000132_extend_fundamentals/g).length, 1, "and nowhere else (not in the run_psql list)");
  assert.ok(!workflow.includes("000132_extend_fundamentals.down.sql"));
  assert.ok(self < workflow.indexOf("DELETE FROM schema_migrations"), "inside the prod migration block");
  const note = workflow.slice(w131, self);
  assert.match(note, /never remove this line to unblock a deploy/i);
  assert.match(note, /task db:prod:apply FILE=services\/migrations\/000132_extend_fundamentals\.up\.sql CONFIRM=prod/);
  assert.match(note, /re-run the deploy, or revert/);
});

// ---------------------------------------------------------------------------
// down

test("down: the same two-transaction shape, 000130's function verbatim first", () => {
  const [tx1, tx2, ...rest] = transactions(down);
  assert.equal(rest.length, 0);
  assert.match(tx1[0].masked, /^SET LOCAL statement_timeout = 0$/);
  assert.match(tx2[0].masked, /^SET LOCAL statement_timeout = 0$/);
  const fn130 = up130.slice(up130.indexOf("CREATE OR REPLACE FUNCTION refresh_strategy_views()"), up130.indexOf("\nCOMMIT;"));
  const fnDown = down.slice(down.indexOf("CREATE OR REPLACE FUNCTION refresh_strategy_views()"), down.indexOf("\nCOMMIT;"));
  assert.equal(fnDown.trim(), fn130.trim(), "000130's body, ALTER FUNCTION and COMMENT, verbatim");
});

test("down: the growth view goes before the quality view, then the columns, then 000129's view verbatim", () => {
  const growthDrop = downCode.indexOf("EXECUTE format('DROP %s %I', 'MATERIALIZED VIEW', 'mv_fundamentals_growth')");
  const qualityDrop = downCode.indexOf("DROP MATERIALIZED VIEW IF EXISTS mv_fundamentals_quality;");
  const columns = downCode.indexOf("ALTER TABLE stock_fundamentals\n    DROP CONSTRAINT IF EXISTS stock_fundamentals_finite_check_v2");
  const rebuild = downCode.indexOf("CREATE MATERIALIZED VIEW IF NOT EXISTS mv_fundamentals_growth AS");
  assert.ok(growthDrop > 0 && qualityDrop > growthDrop && columns > qualityDrop && rebuild > columns);
  assert.match(downCode, /attname = 'revenue_prior_period_end' AND NOT attisdropped\) THEN\s+RETURN;/, "only 000132's definition is dropped");
  assert.equal(viewBody(down, "mv_fundamentals_growth"), viewBody(up129, "mv_fundamentals_growth"), "000129's definition, verbatim");
  for (const [, col] of ADDED_COLUMNS) {
    assert.match(downCode, new RegExp(`DROP COLUMN IF EXISTS ${col}[,;]`), col);
  }
  assert.match(downCode, /ALTER TABLE IF EXISTS financial_report_extractions DROP COLUMN IF EXISTS document_meta;/);
  assert.match(downCode, /DROP TABLE IF EXISTS picks_run_lease;/);
  assert.doesNotMatch(downCode, /DROP TABLE IF EXISTS stock_fundamentals\b/, "000129's tables stay");
  assert.match(downCode, /CREATE UNIQUE INDEX idx_mv_fundamentals_growth_stock_code ON mv_fundamentals_growth \(stock_code\)/);
  assert.match(downCode, /ALTER MATERIALIZED VIEW %I OWNER TO %I/, "the owner and grants are carried back too");
});
