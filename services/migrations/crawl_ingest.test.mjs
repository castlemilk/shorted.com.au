import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const up = readFileSync(
  new URL("./000150_add_crawl_ingest.up.sql", import.meta.url),
  "utf8",
);
const down = readFileSync(
  new URL("./000150_add_crawl_ingest.down.sql", import.meta.url),
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

test("every CREATE is IF NOT EXISTS", () => {
  const creates = up.match(/CREATE\s+(TABLE|INDEX)\b[^\n]*/gi) ?? [];
  assert.ok(creates.length >= 5, "expected the four tables and the index");
  for (const statement of creates) {
    assert.match(statement, /IF NOT EXISTS/i, statement);
  }
});

test("the ingest tables and their keys exist with the contracted shape", () => {
  assert.match(up, /CREATE TABLE IF NOT EXISTS crawl_dispatch \([\s\S]*?job_id\s+TEXT PRIMARY KEY/i);
  assert.match(up, /CREATE TABLE IF NOT EXISTS crawl_ingest_receipts \([\s\S]*?key\s+TEXT PRIMARY KEY[\s\S]*?body_sha256\s+BYTEA NOT NULL[\s\S]*?response\s+JSONB NOT NULL/i);
  assert.match(up, /CREATE INDEX IF NOT EXISTS idx_crawl_ingest_receipts_created_at\s+ON crawl_ingest_receipts \(created_at\)/i);
  assert.match(up, /CREATE TABLE IF NOT EXISTS housing_ingest_rigs \([\s\S]*?subject\s+TEXT PRIMARY KEY[\s\S]*?enabled\s+BOOLEAN NOT NULL DEFAULT false/i);
  assert.match(up, /CREATE TABLE IF NOT EXISTS crawl_ingest_quarantine \([\s\S]*?reason\s+TEXT NOT NULL/i);
});

test("the quarantine table holds reasons and stats, never listing rows", () => {
  const block = up.match(/CREATE TABLE IF NOT EXISTS crawl_ingest_quarantine \([\s\S]*?\);/i)?.[0] ?? "";
  assert.ok(block, "quarantine table definition not found");
  assert.doesNotMatch(block, /listing|address|url|price/i);
});

// ALTER TABLE takes ACCESS EXCLUSIVE even when IF NOT EXISTS skips the change,
// so each column is added only when the catalog lacks it.
test("every ADD COLUMN is nullable, has no default, and sits behind a catalog guard", () => {
  const adds = up.match(/ADD COLUMN IF NOT EXISTS[^;\n]*/gi) ?? [];
  assert.equal(adds.length, 3, "three columns: two on property_listings, one on property_price_events");
  for (const add of adds) {
    assert.doesNotMatch(add, /NOT NULL|DEFAULT/i, add);
  }
  const guards = up.match(/IF NOT EXISTS \(\s*SELECT 1 FROM pg_attribute/gi) ?? [];
  assert.equal(guards.length, 3);
  assert.match(up, /ingest_receipt_key/);
  assert.match(up, /last_missed_at TIMESTAMPTZ/);
});

test("the migration runs under a lock timeout so a blocked ALTER fails the deploy step", () => {
  assert.match(up, /SET LOCAL lock_timeout = '15s'/);
});

test("the down migration is the inverse and is idempotent", () => {
  assert.match(down, /DROP COLUMN IF EXISTS ingest_receipt_key/);
  assert.match(down, /DROP COLUMN IF EXISTS last_missed_at/);
  assert.match(down, /DROP TABLE IF EXISTS crawl_ingest_quarantine/);
  assert.match(down, /DROP TABLE IF EXISTS crawl_dispatch/);
});

test("the migration is in the prod deploy allowlist, before the 000138 lockdown", () => {
  const at = workflow.indexOf("-f /migrations/000150_add_crawl_ingest.up.sql");
  const idx149 = workflow.indexOf("000149_add_past_due_since.up.sql");
  const idx138 = workflow.indexOf("# 000138 closes the Supabase Data API");
  assert.ok(at > 0, "000150 must be in the allowlist, or it never reaches prod");
  assert.ok(idx149 > 0 && at > idx149, "000150 is applied after 000149");
  assert.ok(idx138 > at, "000138 stays the last allowlisted step");
});
