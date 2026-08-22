import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const up = readFileSync(
  new URL("./000112_add_api_usage_monthly.up.sql", import.meta.url),
  "utf8",
);

const down = readFileSync(
  new URL("./000112_add_api_usage_monthly.down.sql", import.meta.url),
  "utf8",
);

const workflow = readFileSync(
  new URL("../../.github/workflows/terraform-deploy.yml", import.meta.url),
  "utf8",
);

test("the usage table is keyed so an upsert resolves instead of duplicating", () => {
  assert.match(up, /CREATE TABLE IF NOT EXISTS api_usage_monthly/i);
  assert.match(up, /PRIMARY KEY \(identifier, period_month\)/i);
});

test("request_count is a BIGINT defaulting to 0 — a missing count is zero, not null", () => {
  assert.match(up, /request_count\s+BIGINT NOT NULL DEFAULT 0/i);
  assert.match(up, /updated_at\s+TIMESTAMPTZ NOT NULL DEFAULT now\(\)/i);
});

// Prod does not run `migrate up`. The deploy replays a hardcoded allowlist on
// EVERY deploy, so a non-idempotent statement here corrupts live quota
// counters several times a week.
test("every statement is idempotent, because prod replays this file on every deploy", () => {
  assert.match(up, /CREATE TABLE IF NOT EXISTS/i);
  assert.match(up, /CREATE INDEX IF NOT EXISTS/i);

  const destructive = /\b(DROP|TRUNCATE|DELETE FROM|ALTER TABLE)\b/i;
  assert.ok(
    !destructive.test(up),
    "a replayed migration must not drop, truncate, delete or alter anything",
  );

  // A bare INSERT/UPDATE would re-apply its effect on every deploy.
  assert.ok(
    !/\bINSERT INTO\b/i.test(up),
    "seeding rows here would re-seed them on every deploy",
  );
});

test("the migration is in the prod deploy allowlist, or it never reaches prod", () => {
  assert.match(
    workflow,
    /-f \/migrations\/000112_add_api_usage_monthly\.up\.sql/,
  );
});

test("000112 stays before 000095 so the hardened MV refresh definition still wins", () => {
  const idx112 = workflow.indexOf("000112_add_api_usage_monthly.up.sql");
  const idx095 = workflow.indexOf("000095_harden_mv_refresh.up.sql");
  assert.ok(idx112 > 0 && idx095 > 0);
  assert.ok(
    idx112 < idx095,
    "000095 must remain the last file applied — see the ORDER IS LOAD-BEARING note",
  );
});

test("the down migration is the exact inverse and is itself idempotent", () => {
  assert.match(down, /DROP INDEX IF EXISTS idx_api_usage_monthly_period/i);
  assert.match(down, /DROP TABLE IF EXISTS api_usage_monthly/i);
});

test("a month-scoped index exists — the primary key is identifier-major and cannot serve retention sweeps", () => {
  assert.match(
    up,
    /CREATE INDEX IF NOT EXISTS idx_api_usage_monthly_period\s+ON api_usage_monthly \(period_month\)/i,
  );
});
