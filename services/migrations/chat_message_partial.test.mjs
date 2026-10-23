import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const up = readFileSync(
  new URL("./000146_add_chat_message_partial.up.sql", import.meta.url),
  "utf8",
);

const down = readFileSync(
  new URL("./000146_add_chat_message_partial.down.sql", import.meta.url),
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

test("the partial flag is a NOT NULL boolean that defaults to FALSE, so existing rows read as complete", () => {
  assert.match(
    sqlOnly(up),
    /ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS partial BOOLEAN NOT NULL DEFAULT FALSE/,
  );
});

// The regression this file exists for. ALTER TABLE takes ACCESS EXCLUSIVE even
// when IF NOT EXISTS skips the change, so every replay would queue behind the
// chat inserts. The add must sit behind a catalog check.
test("the column is added only when the catalog lacks it, so a replay takes no lock", () => {
  const sql = sqlOnly(up);
  const guardAt = sql.search(/IF NOT EXISTS\s*\(\s*SELECT 1\s+FROM pg_attribute/);
  const alterAt = sql.indexOf("ALTER TABLE");
  assert.ok(guardAt > 0, "the add must sit behind a pg_attribute check");
  assert.ok(alterAt > guardAt, "the ALTER must sit behind the catalog guard");
  assert.match(sql, /attname = 'partial'/);
  assert.match(sql, /NOT attisdropped/);
});

test("the migration runs under a lock timeout inside one transaction", () => {
  assert.match(up, /^BEGIN;/m);
  assert.match(up, /SET LOCAL lock_timeout = '15s';/);
  assert.match(up, /^COMMIT;/m);
  const sql = sqlOnly(up);
  assert.ok(sql.indexOf("SET LOCAL lock_timeout") < sql.indexOf("ALTER TABLE"));
});

// Prod replays this file on every deploy. It may add the column once, and
// nothing else: no drop, delete, insert or update of any row.
test("the only ALTER is the guarded add, and no row is ever touched", () => {
  const sql = sqlOnly(up);
  assert.equal((sql.match(/\bALTER TABLE\b/gi) ?? []).length, 1);
  assert.doesNotMatch(sql, /\b(DROP|TRUNCATE|DELETE FROM|INSERT INTO|UPDATE)\b/i);
});

test("the migration is in the prod deploy allowlist, and before the Data API lockdown", () => {
  assert.match(
    workflow,
    /-f \/migrations\/000146_add_chat_message_partial\.up\.sql/,
  );
  const idx146 = workflow.indexOf("000146_add_chat_message_partial.up.sql");
  const idx138 = workflow.indexOf("000138_harden_data_api_grants.up.sql");
  assert.ok(idx146 > 0 && idx138 > 0, "both migrations must be in the workflow");
  assert.ok(idx146 < idx138, "000138 must stay the last migration applied");
});

test("the down migration drops exactly the column the up migration adds", () => {
  assert.match(down, /ALTER TABLE chat_messages DROP COLUMN IF EXISTS partial/i);
  assert.equal((sqlOnly(down).match(/\bDROP\b/gi) ?? []).length, 1);
});
