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

// SQL with its `--` comments removed, so a rule about statements is not tripped
// by the explanatory prose that mentions them.
function sqlOnly(text) {
  return text.split("\n").map((line) => line.replace(/--.*$/, "")).join("\n");
}

// The guarded DO blocks, by their dollar-quote tag. Everything that changes an
// existing object lives in one of these, behind a catalog check.
function guardedBlock(tag) {
  const match = up.match(new RegExp(`DO \\$${tag}\\$([\\s\\S]*?)\\$${tag}\\$;`));
  assert.ok(match, `missing guarded DO block ${tag}`);
  return match[1];
}

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

test("the outcome CHECK admits every state the chat service writes, and only those", () => {
  const check = up.match(/CHECK \(outcome IN \(([^)]*)\)\)/i);
  assert.ok(check, "outcome must carry a CHECK constraint");
  const states = [...check[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(states, [
    "canceled",
    "error",
    "failed_before_model",
    "limited",
    "ok",
    "pending",
  ]);
});

test("the CHECK is named, so a replay can find and widen it", () => {
  assert.match(up, /CONSTRAINT chat_usage_events_outcome_check\s+CHECK \(outcome IN/i);
});

test("the outcome CHECK is widened only when the current definition lacks the new outcome", () => {
  const block = guardedBlock("m145_check");
  assert.match(block, /definition NOT LIKE '%failed_before_model%'/);
  // The ALTERs must sit after the guard, inside the same IF.
  const guardAt = block.indexOf("definition NOT LIKE");
  const alterAt = block.indexOf("ALTER TABLE");
  assert.ok(guardAt > 0 && alterAt > guardAt, "the ALTERs must sit behind the catalog guard");
});

test("both indexes exist, and are created only when the catalog lacks them", () => {
  for (const [name, columns] of [
    ["idx_chat_usage_events_user_created", "(user_id, created_at DESC)"],
    ["idx_chat_usage_events_created", "(created_at)"],
  ]) {
    assert.match(up, new RegExp(`to_regclass\\('${name}'\\) IS NULL`));
    assert.match(
      up,
      new RegExp(`CREATE INDEX ${name} ON chat_usage_events ${columns.replace(/[()]/g, "\\$&")}`),
    );
  }
});

// The regression this file exists for. CREATE INDEX IF NOT EXISTS takes a SHARE
// lock on the table before it checks the name, so every replay queued behind the
// chat inserts. Measured on Postgres 15: a 5 second wait behind a 6 second insert.
test("no CREATE INDEX runs unguarded: a replay must never take a lock on the table", () => {
  const unguarded = sqlOnly(up).replace(/EXECUTE '[^']*'/g, "");
  assert.doesNotMatch(unguarded, /CREATE INDEX/i, "CREATE INDEX must sit inside a catalog-guarded EXECUTE");
  assert.match(up, /IF to_regclass\('idx_chat_usage_events_user_created'\) IS NULL THEN/);
  assert.match(up, /IF to_regclass\('idx_chat_usage_events_created'\) IS NULL THEN/);
});

test("the migration runs under a lock timeout, as 000136 does, inside one transaction", () => {
  assert.match(up, /^BEGIN;/m);
  assert.match(up, /SET LOCAL lock_timeout = '15s';/);
  assert.match(up, /^COMMIT;/m);
  assert.ok(up.indexOf("SET LOCAL lock_timeout") < up.indexOf("CREATE TABLE IF NOT EXISTS"));
});

test("the comment is rewritten only when its text differs", () => {
  const block = guardedBlock("m145_comment");
  assert.match(block, /IS DISTINCT FROM note/);
});

// Prod replays this file on every deploy. Nothing may drop, truncate, delete or
// write a row. ALTER TABLE is allowed only inside the guarded widening block.
test("every statement is idempotent, because prod replays this file on every deploy", () => {
  // The widening block is the one place a replay may DROP or ALTER, and it is
  // checked separately above. Everything outside it must be inert.
  const inert = sqlOnly(up).replace(guardedBlock("m145_check"), "");
  assert.doesNotMatch(inert, /\b(DROP|TRUNCATE|DELETE FROM)\b/i);
  assert.doesNotMatch(inert, /\bALTER TABLE\b/i);
  assert.doesNotMatch(inert, /\bINSERT INTO\b/i, "seeding rows here would re-seed them on every deploy");
  assert.doesNotMatch(inert, /\bUPDATE\s+chat_usage_events\b/i, "updating rows here would rewrite live usage");
  for (const statement of up.matchAll(/^CREATE TABLE\b[^\n]*/gim)) {
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
