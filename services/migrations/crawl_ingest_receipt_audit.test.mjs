import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// node --test services/migrations/crawl_ingest_receipt_audit.test.mjs
//
// 000152 adds the token audit columns to crawl_ingest_receipts. Prod replays every
// allowlisted migration on every deploy, so the file must be idempotent and must not
// touch rows, and it must sit in the allowlist after 000151 and above the 000138 closer.

const up = readFileSync(
  new URL("./000152_add_crawl_ingest_receipt_audit.up.sql", import.meta.url),
  "utf8",
);
const down = readFileSync(
  new URL("./000152_add_crawl_ingest_receipt_audit.down.sql", import.meta.url),
  "utf8",
);
const workflow = readFileSync(
  new URL("../../.github/workflows/terraform-deploy.yml", import.meta.url),
  "utf8",
);

// The SQL with comment lines removed, so a word in a comment cannot satisfy or fail a check.
function code(sql) {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

test("the two audit columns are added, nullable, and nothing else", () => {
  const body = code(up);
  assert.match(body, /attname = 'jwt_jti'/);
  assert.match(body, /attname = 'jwt_kid'/);
  assert.match(body, /ADD COLUMN IF NOT EXISTS jwt_jti TEXT;/);
  assert.match(body, /ADD COLUMN IF NOT EXISTS jwt_kid TEXT;/);
  assert.doesNotMatch(body, /jwt_(jti|kid)\s+TEXT\s+NOT NULL/i, "the columns must be nullable");
  assert.doesNotMatch(body, /DEFAULT/i, "a default would rewrite or backfill the table");
});

// ALTER TABLE takes ACCESS EXCLUSIVE even for a no-op, so every ALTER must sit behind
// the catalog check, and the step must run under a bounded lock_timeout.
test("every ALTER is behind a catalog check, under a bounded lock", () => {
  const body = code(up);
  const alters = [...body.matchAll(/ALTER TABLE/gi)].length;
  const guards = [...body.matchAll(/IF NOT EXISTS \(\s*SELECT 1 FROM pg_attribute/gi)].length;
  assert.equal(alters, guards, "each ALTER TABLE needs its own pg_attribute guard");
  assert.match(body, /SET LOCAL lock_timeout = '15s'/);
});

test("it is idempotent and touches no rows", () => {
  const body = code(up);
  assert.doesNotMatch(body, /\b(DROP|TRUNCATE|DELETE FROM|UPDATE|INSERT INTO)\b/i);
  assert.doesNotMatch(body, /ALTER COLUMN|ALTER TABLE \w+ DROP/i);
});

test("the file is one transaction", () => {
  const body = code(up);
  assert.match(body, /^\s*BEGIN;/m);
  assert.match(body, /^\s*COMMIT;/m);
});

test("the down file removes only what the up file added", () => {
  const body = code(down);
  assert.match(body, /DROP COLUMN IF EXISTS jwt_jti/);
  assert.match(body, /DROP COLUMN IF EXISTS jwt_kid/);
});

test("it is in the prod allowlist, after 000151 and above the 000138 closer", () => {
  const line = "-f /migrations/000152_add_crawl_ingest_receipt_audit.up.sql";
  const idx = workflow.indexOf(line);
  assert.ok(idx > 0, "000152 must be in terraform-deploy.yml");
  assert.equal(workflow.indexOf(line), workflow.lastIndexOf(line), "listed exactly once");
  assert.ok(workflow.indexOf("-f /migrations/000151_add_crawl_finalize_state.up.sql") < idx);
  assert.ok(idx < workflow.indexOf("# 000138 closes the Supabase Data API"));
});
