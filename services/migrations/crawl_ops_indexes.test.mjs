import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// node --test services/migrations/crawl_ops_indexes.test.mjs
//
// 000153 adds three indexes for the admin housing-crawl tools. Prod replays every allowlisted migration
// on every deploy, so the file must be idempotent, touch no rows, take no table lock on a replay with
// the indexes present, run as one transaction under a bounded lock, and sit in the allowlist after 000152.

const up = readFileSync(new URL("./000153_add_crawl_ops_indexes.up.sql", import.meta.url), "utf8");
const down = readFileSync(new URL("./000153_add_crawl_ops_indexes.down.sql", import.meta.url), "utf8");
const workflow = readFileSync(new URL("../../.github/workflows/terraform-deploy.yml", import.meta.url), "utf8");

// The SQL with comment lines removed, so a word in a comment cannot satisfy or fail a check.
function code(sql) {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

test("it creates exactly the three indexes the admin queries use", () => {
  const body = code(up);
  assert.match(body, /CREATE INDEX idx_crawl_ingest_receipts_job_id\s+ON crawl_ingest_receipts \(split_part\(key, ':', 1\)\);/);
  assert.match(body, /CREATE INDEX idx_crawl_dispatch_run_id ON crawl_dispatch \(run_id\);/);
  assert.match(body, /CREATE INDEX idx_crawl_dispatch_open_suburb\s+ON crawl_dispatch \(\(lower\(replace\(suburb, ' ', '-'\)\)\)\)\s+WHERE closed_at IS NULL;/);
  assert.equal([...body.matchAll(/CREATE INDEX idx_/g)].length, 3);
});

// The replay must not take a SHARE lock on a table just to find an index already there. CREATE INDEX IF
// NOT EXISTS does, so it may not appear outside the catalog guard.
test("every CREATE INDEX sits behind a catalog check of a valid index", () => {
  const body = code(up);
  const creates = [...body.matchAll(/CREATE INDEX idx_/g)].length;
  const guards = [...body.matchAll(/SELECT 1 FROM pg_class c JOIN pg_index x ON x\.indexrelid = c\.oid\s+WHERE c\.relname = '(idx_[a-z_]+)' AND x\.indisvalid/g)];
  assert.equal(guards.length, creates, "each CREATE INDEX needs its own pg_index guard");
  assert.doesNotMatch(body, /CREATE INDEX IF NOT EXISTS/, "IF NOT EXISTS takes the table lock before it checks");
  for (const g of guards) {
    assert.match(body, new RegExp(`IF NOT EXISTS \\([\\s\\S]*?${g[1]}[\\s\\S]*?THEN`), `${g[1]} is checked before it is created`);
  }
});

test("the open-suburb index predicate matches the read that uses it", () => {
  const store = readFileSync(
    new URL("../../services/shorts/internal/store/shorts/postgres_crawl_ops.go", import.meta.url),
    "utf8",
  );
  assert.match(store, /lower\(replace\(suburb, ' ', '-'\)\) = \$1 AND closed_at IS NULL/);
});

test("it is idempotent, touches no rows and drops nothing it did not create", () => {
  const body = code(up);
  assert.doesNotMatch(body, /\b(TRUNCATE|DELETE FROM|UPDATE|INSERT INTO|ALTER TABLE)\b/i);
  const drops = [...body.matchAll(/DROP INDEX IF EXISTS (\w+)/g)].map((m) => m[1]).sort();
  assert.deepEqual(drops, ["idx_crawl_dispatch_open_suburb", "idx_crawl_dispatch_run_id", "idx_crawl_ingest_receipts_job_id"],
    "a drop is only ever the invalid leftover of one of these three indexes");
});

test("the file is one transaction under a bounded lock", () => {
  const body = code(up);
  assert.match(body, /^\s*BEGIN;/m);
  assert.match(body, /^\s*COMMIT;/m);
  assert.match(body, /SET LOCAL lock_timeout = '15s'/);
});

test("the down file removes only the three indexes and nothing else", () => {
  const body = code(down);
  assert.equal([...body.matchAll(/DROP INDEX IF EXISTS/gi)].length, 3);
  assert.match(body, /DROP INDEX IF EXISTS idx_crawl_dispatch_open_suburb;/);
  assert.match(body, /DROP INDEX IF EXISTS idx_crawl_dispatch_run_id;/);
  assert.match(body, /DROP INDEX IF EXISTS idx_crawl_ingest_receipts_job_id;/);
  assert.doesNotMatch(body, /\bDROP\s+(TABLE|COLUMN|FUNCTION)\b/i);
});

test("it is in the prod deploy allowlist, after 000152", () => {
  const at152 = workflow.indexOf("run_psql_session -f /migrations/000152_add_crawl_ingest_receipt_audit.up.sql");
  const at153 = workflow.indexOf("run_psql_session -f /migrations/000153_add_crawl_ops_indexes.up.sql");
  assert.ok(at152 > 0, "000152 is allowlisted");
  assert.ok(at153 > at152, "000153 runs after 000152, before the image swap");
});
