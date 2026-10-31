import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// node --test services/migrations/crawl_ops_indexes.test.mjs
//
// 000153 adds three indexes for the admin housing-crawl tools. Prod replays every allowlisted
// migration on every deploy, so the file must be idempotent, touch no rows, run as one transaction
// under a bounded lock, and sit in the allowlist after 000152.

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
  assert.match(body, /CREATE INDEX IF NOT EXISTS idx_crawl_ingest_receipts_job_id\s+ON crawl_ingest_receipts \(split_part\(key, ':', 1\)\);/);
  assert.match(body, /CREATE INDEX IF NOT EXISTS idx_crawl_dispatch_run_id\s+ON crawl_dispatch \(run_id\);/);
  assert.match(body, /CREATE INDEX IF NOT EXISTS idx_crawl_dispatch_open_suburb\s+ON crawl_dispatch \(\(lower\(replace\(suburb, ' ', '-'\)\)\)\)\s+WHERE closed_at IS NULL;/);
  assert.equal([...body.matchAll(/CREATE INDEX/gi)].length, 3);
});

test("the open-suburb index predicate matches the read that uses it", () => {
  // The store reads closed_at IS NULL with an expression on suburb; the index must cover the same.
  const store = readFileSync(
    new URL("../../services/shorts/internal/store/shorts/postgres_crawl_ops.go", import.meta.url),
    "utf8",
  );
  assert.match(store, /lower\(replace\(suburb, ' ', '-'\)\) = \$1 AND closed_at IS NULL/);
});

test("it is idempotent, touches no rows and drops nothing", () => {
  const body = code(up);
  assert.doesNotMatch(body, /\b(DROP|TRUNCATE|DELETE FROM|UPDATE|INSERT INTO|ALTER TABLE)\b/i);
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
