import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const up = readFileSync(
  new URL("./000147_add_alert_events.up.sql", import.meta.url),
  "utf8",
);
const down = readFileSync(
  new URL("./000147_add_alert_events.down.sql", import.meta.url),
  "utf8",
);
const workflow = readFileSync(
  new URL("../../.github/workflows/terraform-deploy.yml", import.meta.url),
  "utf8",
);

// SQL with its `--` comments removed, so a rule about statements is not tripped
// by the explanatory prose that mentions them.
function sqlOnly(text) {
  return text
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

// The guarded DO block for an index, by its dollar-quote tag.
function guardedBlock(tag) {
  const match = up.match(new RegExp(`DO \\$${tag}\\$([\\s\\S]*?)\\$${tag}\\$;`));
  assert.ok(match, `missing guarded DO block ${tag}`);
  return match[1];
}

// The SQL with comments removed and every run of whitespace folded to one space,
// so a column reads the same whatever its alignment.
const flat = sqlOnly(up).replace(/\s+/g, " ");

test("alert_events has the columns the evaluator and the API read", () => {
  for (const column of [
    "id BIGSERIAL PRIMARY KEY",
    "monitor_id TEXT NOT NULL REFERENCES alert_monitors(id) ON DELETE CASCADE",
    "user_id TEXT NOT NULL",
    "scope TEXT NOT NULL",
    "target TEXT NOT NULL",
    "condition TEXT NOT NULL",
    "threshold DOUBLE PRECISION",
    "cadence TEXT NOT NULL",
    "report_date DATE NOT NULL",
    "compared_to_date DATE NOT NULL",
    "latest_percent DOUBLE PRECISION",
    "previous_percent DOUBLE PRECISION",
    "payload JSONB NOT NULL DEFAULT '{}'::jsonb",
    "email_status TEXT NOT NULL",
    "email_attempts SMALLINT NOT NULL DEFAULT 0",
    "last_error TEXT",
    "resend_id TEXT",
    "send_claimed_at TIMESTAMPTZ",
    "sent_at TIMESTAMPTZ",
    "run_id BIGINT",
  ]) {
    assert.ok(flat.includes(column), `alert_events must declare ${column}`);
  }
});

test("alert_events references alert_monitors with ON DELETE CASCADE, so a deleted monitor takes its history", () => {
  assert.match(up, /REFERENCES alert_monitors\(id\) ON DELETE CASCADE/);
});

test("one event per monitor per report date: the UNIQUE key makes evaluation idempotent", () => {
  assert.match(up, /CONSTRAINT alert_events_monitor_report_unique UNIQUE \(monitor_id, report_date\)/);
});

test("the email_status CHECK admits exactly the statuses the shared contract declares", () => {
  const check = up.match(/alert_events_email_status_check CHECK \(email_status IN\s*\(([^)]*)\)\)/);
  assert.ok(check, "email_status must carry a named CHECK");
  const states = [...check[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(states, [
    "awaiting_entitlement",
    "failed",
    "pending",
    "sending",
    "sent",
    "skipped_no_email",
    "skipped_paused",
    "skipped_unentitled",
  ]);
});

test("the cadence CHECK admits daily and weekly only", () => {
  assert.match(up, /alert_events_cadence_check CHECK \(cadence IN \('daily', 'weekly'\)\)/);
});

test("the evaluator state is a singleton", () => {
  assert.match(up, /CREATE TABLE IF NOT EXISTS alert_evaluator_state/);
  assert.match(up, /id\s+SMALLINT PRIMARY KEY DEFAULT 1 CONSTRAINT alert_evaluator_state_singleton CHECK \(id = 1\)/);
  assert.match(up, /daily_through\s+DATE,/);
  assert.match(up, /weekly_through\s+DATE,/);
  assert.match(up, /last_canary_at\s+TIMESTAMPTZ,/);
});

test("the run log admits only its four outcomes", () => {
  const check = up.match(/CHECK \(outcome IN \(([^)]*)\)\)/);
  assert.ok(check, "outcome must carry a CHECK");
  const states = [...check[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(states, ["degraded", "failed", "running", "succeeded"]);
});

test("every index is created only when the catalog lacks it, never bare", () => {
  const unguarded = sqlOnly(up).replace(/EXECUTE '[^']*'/g, "");
  assert.doesNotMatch(unguarded, /CREATE (UNIQUE )?INDEX/i, "CREATE INDEX must sit inside a catalog-guarded EXECUTE");
  for (const [tag, name] of [
    ["m147_idx_user", "idx_alert_events_user_report"],
    ["m147_idx_queue", "idx_alert_events_delivery_queue"],
    ["m147_idx_runs", "idx_alert_evaluator_runs_started"],
  ]) {
    const block = guardedBlock(tag);
    assert.match(block, new RegExp(`to_regclass\\('${name}'\\) IS NULL`));
    assert.match(block, new RegExp(`CREATE INDEX ${name} ON`));
  }
});

test("the user event index serves the list, newest report first", () => {
  assert.match(
    guardedBlock("m147_idx_user"),
    /CREATE INDEX idx_alert_events_user_report ON alert_events \(user_id, report_date DESC, id DESC\)/,
  );
});

test("the send queue is a partial index over the rows still waiting on Resend", () => {
  assert.match(
    guardedBlock("m147_idx_queue"),
    /CREATE INDEX idx_alert_events_delivery_queue ON alert_events \(created_at, id\) WHERE email_status IN \(''pending'', ''sending''\)/,
  );
});

test("the migration runs under a lock timeout, inside one transaction", () => {
  assert.match(up, /^BEGIN;/m);
  assert.match(up, /SET LOCAL lock_timeout = '15s';/);
  assert.match(up, /^COMMIT;/m);
  assert.ok(up.indexOf("SET LOCAL lock_timeout") < up.indexOf("CREATE TABLE IF NOT EXISTS alert_events"));
});

test("every CREATE TABLE is replay-safe", () => {
  for (const statement of up.matchAll(/^CREATE TABLE\b[^\n]*/gim)) {
    assert.match(statement[0], /IF NOT EXISTS/i, `not replay-safe: ${statement[0]}`);
  }
});

// Prod replays this file on every deploy. Nothing may drop, write a row, add a
// column or grant. The file touches no rows.
test("the file is inert on replay: no drop, no ADD COLUMN, no INSERT, no UPDATE, no GRANT", () => {
  const body = sqlOnly(up);
  assert.doesNotMatch(body, /\b(DROP|TRUNCATE|DELETE FROM)\b/i);
  assert.doesNotMatch(body, /\bADD COLUMN\b/i);
  assert.doesNotMatch(body, /\bINSERT INTO\b/i, "seeding rows here would re-seed them on every deploy");
  assert.doesNotMatch(body, /\bUPDATE\s+(alert_events|alert_evaluator_state|alert_evaluator_runs)\b/i);
  assert.doesNotMatch(body, /\bGRANT\b/i);
});

test("the comment is rewritten only when its text differs", () => {
  assert.match(guardedBlock("m147_comment"), /IS DISTINCT FROM note/);
});

test("the migration is allowlisted in the prod deploy, after 000074 and 000146 and before 000138", () => {
  const idx074 = workflow.indexOf("-f /migrations/000074_add_alert_monitors.up.sql");
  const idx146 = workflow.indexOf("-f /migrations/000146_add_chat_message_partial.up.sql");
  const idx147 = workflow.indexOf("-f /migrations/000147_add_alert_events.up.sql");
  const idx138 = workflow.indexOf("-f /migrations/000138_harden_data_api_grants.up.sql");
  assert.ok(idx074 > 0 && idx146 > 0 && idx147 > 0 && idx138 > 0, "every migration must be allowlisted");
  assert.ok(idx074 < idx147, "000147 references alert_monitors, which 000074 creates");
  assert.ok(idx146 < idx147, "000147 is listed immediately after 000146");
  assert.ok(idx147 < idx138, "000138 must stay the last migration applied, so the Data API lockdown covers 000147");
});

test("the down migration drops exactly what the up migration creates", () => {
  for (const name of [
    "idx_alert_evaluator_runs_started",
    "idx_alert_events_delivery_queue",
    "idx_alert_events_user_report",
  ]) {
    assert.match(down, new RegExp(`DROP INDEX IF EXISTS ${name}`));
  }
  for (const table of ["alert_evaluator_runs", "alert_evaluator_state", "alert_events"]) {
    assert.match(down, new RegExp(`DROP TABLE IF EXISTS ${table}`));
  }
});
