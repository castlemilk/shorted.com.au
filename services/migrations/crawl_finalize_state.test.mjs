import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const up = readFileSync(
  new URL("./000151_add_crawl_finalize_state.up.sql", import.meta.url),
  "utf8",
);
const down = readFileSync(
  new URL("./000151_add_crawl_finalize_state.down.sql", import.meta.url),
  "utf8",
);
const workflow = readFileSync(
  new URL("../../.github/workflows/terraform-deploy.yml", import.meta.url),
  "utf8",
);

// Prod replays this file on every deploy, so it must never touch a row.
test("nothing in the up migration reads or writes a row", () => {
  assert.doesNotMatch(up, /\bINSERT\s+INTO\b/i);
  assert.doesNotMatch(up, /\bUPDATE\s+\w+\s+SET\b/i);
  assert.doesNotMatch(up, /\bDELETE\s+FROM\b/i);
  assert.doesNotMatch(up, /\bTRUNCATE\b/i);
  assert.doesNotMatch(up, /\bDROP\s+(TABLE|COLUMN|INDEX)\b/i);
});

test("the cursor and lease tables are keyed by name and every CREATE is IF NOT EXISTS", () => {
  // Count statements, not the words in the header comment.
  const sql = up.replace(/--.*$/gm, "");
  const creates = sql.match(/CREATE\s+(TABLE|INDEX)\b[^\n]*/gi) ?? [];
  assert.equal(creates.length, 2, "the cursor and the lease, no index");
  for (const create of creates) assert.match(create, /IF NOT EXISTS/i);
  assert.match(
    up,
    /CREATE TABLE IF NOT EXISTS crawl_finalize_state \([\s\S]*?name\s+TEXT PRIMARY KEY[\s\S]*?watermark\s+TIMESTAMPTZ NOT NULL/i,
  );
  assert.match(
    up,
    /CREATE TABLE IF NOT EXISTS crawl_finalize_lease \([\s\S]*?name\s+TEXT PRIMARY KEY[\s\S]*?holder\s+TEXT NOT NULL[\s\S]*?expires_at\s+TIMESTAMPTZ NOT NULL/i,
  );
});

test("the migration runs under a lock timeout", () => {
  assert.match(up, /SET LOCAL lock_timeout = '15s'/);
});

test("the down migration drops only the cursor and lease, and is idempotent", () => {
  assert.match(down, /DROP TABLE IF EXISTS crawl_finalize_state;/);
  assert.match(down, /DROP TABLE IF EXISTS crawl_finalize_lease;/);
  assert.doesNotMatch(down, /crawl_ingest|crawl_dispatch|property_/);
});

test("the migration is allowlisted after 000150 and before the 000138 lockdown", () => {
  const at = workflow.indexOf("-f /migrations/000151_add_crawl_finalize_state.up.sql");
  const at150 = workflow.indexOf("-f /migrations/000150_add_crawl_ingest.up.sql");
  const idx138 = workflow.indexOf("# 000138 closes the Supabase Data API");
  assert.ok(at > 0, "000151 must be in the allowlist, or it never reaches prod");
  assert.ok(at150 > 0 && at > at150, "000151 is applied after 000150");
  assert.ok(idx138 > at, "000138 stays the last allowlisted step");
});
