// node --test services/migrations/ownership.test.mjs
//
// 000137 is in the deploy allowlist, so prod RE-RUNS it on every deploy. These
// assertions pin what makes that safe and the columns the ownership job
// (services/jobs/internal/jobs/ownership) and the API read.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const up = readFileSync(new URL("./000137_add_ownership.up.sql", import.meta.url), "utf8");
const down = readFileSync(new URL("./000137_add_ownership.down.sql", import.meta.url), "utf8");
const workflow = readFileSync(
  new URL("../../.github/workflows/terraform-deploy.yml", import.meta.url),
  "utf8",
);
const registry = readFileSync(
  new URL("../jobs/internal/jobs/ownership/registry.go", import.meta.url),
  "utf8",
);

/** SQL with `--` comments removed, so prose never satisfies an assertion. */
const code = (sql) => sql.replace(/--.*$/gm, "");
const upCode = code(up);

const TABLES = [
  "ownership_institutions",
  "substantial_holder_notices",
  "substantial_holder_notice_attempts",
  "ownership_funds",
  "security_identifiers",
  "fund_holding_snapshots",
  "fund_holdings",
];

test("every table, index and view is created only when absent", () => {
  for (const table of TABLES) {
    assert.match(upCode, new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(`), table);
  }
  const creates = upCode.match(/CREATE (?:UNIQUE )?INDEX\b[^;]*/g) ?? [];
  assert.ok(creates.length > 0);
  for (const stmt of creates) {
    assert.match(stmt, /CREATE (?:UNIQUE )?INDEX IF NOT EXISTS/, stmt);
  }
  assert.match(upCode, /CREATE OR REPLACE VIEW v_substantial_holdings_current AS/);
  assert.match(upCode, /CREATE OR REPLACE VIEW v_fund_holdings_latest AS/);
});

test("a replay reads and writes no rows", () => {
  assert.doesNotMatch(upCode, /\b(DROP|TRUNCATE|DELETE FROM|UPDATE|INSERT INTO|ALTER TABLE)\b/i);
  assert.doesNotMatch(upCode, /MATERIALIZED VIEW/i, "a materialized view cannot be changed by a replay");
});

test("the index on asx_announcements waits at most 15 seconds for its lock", () => {
  assert.match(upCode, /BEGIN;\s*SET LOCAL lock_timeout = '15s';/);
  assert.match(upCode, /CREATE INDEX IF NOT EXISTS idx_asx_ann_substantial\s+ON asx_announcements/);
  assert.match(upCode, /COMMIT;\s*$/);
});

test("the notices pass's headline filter repeats the partial index's predicate", () => {
  const store = readFileSync(
    new URL("../jobs/internal/jobs/ownership/store.go", import.meta.url),
    "utf8",
  );
  assert.match(upCode, /WHERE headline ILIKE '%substantial%'/);
  assert.match(store, /a\.headline ILIKE '%substantial%'/);
});

test("the kind CHECK lists exactly the kinds the Go registry declares", () => {
  const check = upCode.match(/ownership_institutions_kind_check CHECK \(kind IN \(([^)]*)\)\)/);
  assert.ok(check, "kind CHECK missing");
  const sqlKinds = [...check[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
  const goKinds = [...registry.matchAll(/Kind[A-Za-z]+\s+Kind = "([a-z_]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(sqlKinds, goKinds);
});

test("a voting power is a percentage, and a notice is one of the four forms", () => {
  assert.match(upCode, /present_pct IS NULL OR \(present_pct >= 0 AND present_pct <= 100\)/);
  assert.match(upCode, /previous_pct IS NULL OR \(previous_pct >= 0 AND previous_pct <= 100\)/);
  assert.match(upCode, /form IN \('603', '604', '605', 'nz'\)/);
});

test("the current-holdings view drops a holder whose latest notice ceased", () => {
  const view = upCode.slice(upCode.indexOf("CREATE OR REPLACE VIEW v_substantial_holdings_current"));
  assert.match(view, /DISTINCT ON \(n\.stock_code, n\.holder_key\)/);
  assert.match(view, /ORDER BY n\.stock_code, n\.holder_key, COALESCE\(n\.event_date, n\.announced_on\) DESC/);
  assert.match(view, /WHERE NOT latest\.ceased AND latest\.present_pct IS NOT NULL/);
});

test("a snapshot is unique per fund and date, so a re-run rewrites it", () => {
  assert.match(upCode, /UNIQUE \(institution_slug, fund_name, as_at\)/);
  assert.match(upCode, /REFERENCES fund_holding_snapshots \(id\) ON DELETE CASCADE/);
});

test("the migration is in the prod deploy allowlist, or it never reaches prod", () => {
  assert.match(workflow, /-f \/migrations\/000137_add_ownership\.up\.sql/);
});

test("the down migration drops everything the up creates", () => {
  for (const table of TABLES) {
    assert.match(down, new RegExp(`DROP TABLE IF EXISTS ${table};`), table);
  }
  assert.match(down, /DROP VIEW IF EXISTS v_substantial_holdings_current;/);
  assert.match(down, /DROP VIEW IF EXISTS v_fund_holdings_latest;/);
  assert.match(down, /DROP INDEX IF EXISTS idx_asx_ann_substantial;/);
});
