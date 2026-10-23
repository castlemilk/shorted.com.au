import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const up = readFileSync(
  new URL("./000145_add_chat_usage_events.up.sql", import.meta.url),
  "utf8",
);

const down = readFileSync(
  new URL("./000145_add_chat_usage_events.down.sql", import.meta.url),
  "utf8",
);

const workflow = readFileSync(
  new URL("../../.github/workflows/terraform-deploy.yml", import.meta.url),
  "utf8",
);

test("the ledger table is created with the columns the chat service writes", () => {
  assert.match(up, /CREATE TABLE IF NOT EXISTS chat_usage_events/i);
  assert.match(up, /id BIGSERIAL PRIMARY KEY/i);
  assert.match(up, /user_id TEXT NOT NULL/i);
  assert.match(up, /conversation_id UUID,/i);
  assert.match(up, /created_at TIMESTAMPTZ NOT NULL DEFAULT now\(\)/i);
  assert.match(up, /input_tokens INT,/i);
  assert.match(up, /output_tokens INT,/i);
  assert.match(up, /tool_calls INT NOT NULL DEFAULT 0/i);
  assert.match(up, /model TEXT/i);
});

test("conversation_id is a UUID with no foreign key, so usage outlives a deleted conversation", () => {
  assert.doesNotMatch(up, /REFERENCES/i);
});

test("the outcome CHECK admits every state the chat service writes", () => {
  const check = up.match(/outcome TEXT NOT NULL\s+CHECK \(outcome IN \(([^)]*)\)\)/i);
  assert.ok(check, "outcome must carry a CHECK constraint");
  for (const state of ["pending", "ok", "error", "limited", "canceled"]) {
    assert.match(check[1], new RegExp(`'${state}'`));
  }
});

test("both indexes exist: the per-user windows and the global per-minute scan", () => {
  assert.match(
    up,
    /CREATE INDEX IF NOT EXISTS idx_chat_usage_events_user_created\s+ON chat_usage_events \(user_id, created_at DESC\)/i,
  );
  assert.match(
    up,
    /CREATE INDEX IF NOT EXISTS idx_chat_usage_events_created\s+ON chat_usage_events \(created_at\)/i,
  );
});

// Prod replays this file on every deploy. Anything destructive or row-touching
// would rewrite usage on every deploy.
test("every statement is idempotent, because prod replays this file on every deploy", () => {
  const destructive = /\b(DROP|TRUNCATE|DELETE FROM|ALTER TABLE)\b/i;
  assert.ok(
    !destructive.test(up),
    "a replayed migration must not drop, truncate, delete or alter anything",
  );
  assert.ok(
    !/\bINSERT INTO\b/i.test(up),
    "seeding rows here would re-seed them on every deploy",
  );
  assert.ok(
    !/\bUPDATE\s+chat_usage_events\b/i.test(up),
    "updating rows here would rewrite live usage on every deploy",
  );
  for (const statement of up.matchAll(/^CREATE (TABLE|INDEX)\b[^\n]*/gim)) {
    assert.match(statement[0], /IF NOT EXISTS/i, `not replay-safe: ${statement[0]}`);
  }
});

test("the migration is in the prod deploy allowlist, or it never reaches prod", () => {
  assert.match(
    workflow,
    /-f \/migrations\/000145_add_chat_usage_events\.up\.sql/,
  );
});

test("000145 is applied before the deploy-time Data API lockdown (000138), so the lockdown covers it", () => {
  const idx145 = workflow.indexOf("000145_add_chat_usage_events.up.sql");
  const idx138 = workflow.indexOf("000138_harden_data_api_grants.up.sql");
  assert.ok(idx145 > 0 && idx138 > 0);
  assert.ok(idx145 < idx138, "000138 must stay the last migration applied");
});

test("the down migration drops exactly what the up migration creates", () => {
  assert.match(down, /DROP INDEX IF EXISTS idx_chat_usage_events_created/i);
  assert.match(down, /DROP INDEX IF EXISTS idx_chat_usage_events_user_created/i);
  assert.match(down, /DROP TABLE IF EXISTS chat_usage_events/i);
});
