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

// 000154 (notice read_by): the mark the model pass writes and the API reads. It is in the
// deploy allowlist ABOVE 000138, and every ALTER runs only when the catalog lacks it.
const readByUp = readFileSync(new URL("./000154_notice_read_by.up.sql", import.meta.url), "utf8");
const readByDown = readFileSync(new URL("./000154_notice_read_by.down.sql", import.meta.url), "utf8");
const readByUpCode = code(readByUp);

test("000154 adds read_by to both notice tables, defaulting to parser, and checks its two values", () => {
  for (const table of ["substantial_holder_notices", "substantial_holder_notice_attempts"]) {
    assert.match(readByUpCode, new RegExp(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS read_by TEXT NOT NULL DEFAULT 'parser'`), table);
    assert.match(readByUpCode, new RegExp(`ALTER TABLE ${table}\\s+ADD CONSTRAINT ${table}_read_by_check CHECK \\(read_by IN \\('parser', 'model'\\)\\)`), table);
  }
});

test("000154 takes no lock and touches no rows on a replay: every ALTER sits behind a catalog check", () => {
  assert.match(readByUpCode, /BEGIN;\s*SET LOCAL lock_timeout = '15s';/);
  assert.match(readByUpCode, /COMMIT;\s*$/);
  const alters = readByUpCode.match(/ALTER TABLE[^;]*;/g) ?? [];
  assert.equal(alters.length, 4);
  for (const alter of alters) {
    const at = readByUpCode.indexOf(alter);
    const before = readByUpCode.slice(0, at);
    assert.match(before.slice(before.lastIndexOf("DO $")), /IF NOT EXISTS \(/, alter);
  }
  assert.doesNotMatch(readByUpCode, /\b(UPDATE|INSERT INTO|DELETE FROM|TRUNCATE)\b/i);
  // IF NOT EXISTS alone would still take the lock on a replay; it is kept for the deploy's replay
  // lint (migration-drift.test.mjs), and the catalog check above it is what skips the lock.
  assert.match(readByUpCode, /IF NOT EXISTS \(\s*SELECT 1 FROM pg_attribute/, "the ADD COLUMN must sit behind a pg_attribute check");
});

test("000154 is in the prod deploy allowlist above 000138, the Data API lockdown that stays last", () => {
  const at = workflow.indexOf("-f /migrations/000154_notice_read_by.up.sql");
  assert.ok(at > 0, "000154 missing from terraform-deploy.yml");
  assert.ok(at < workflow.indexOf("-f /migrations/000138_harden_data_api_grants.up.sql"));
  assert.ok(at > workflow.indexOf("-f /migrations/000153_add_crawl_ops_indexes.up.sql"));
});

test("the 000154 down file drops the checks and the columns", () => {
  for (const table of ["substantial_holder_notices", "substantial_holder_notice_attempts"]) {
    assert.match(readByDown, new RegExp(`DROP CONSTRAINT IF EXISTS ${table}_read_by_check`), table);
    assert.match(readByDown, new RegExp(`ALTER TABLE ${table} DROP COLUMN IF EXISTS read_by`), table);
  }
});
