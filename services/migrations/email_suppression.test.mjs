import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const up = readFileSync(
  new URL("./000148_add_email_suppression.up.sql", import.meta.url),
  "utf8",
);
const down = readFileSync(
  new URL("./000148_add_email_suppression.down.sql", import.meta.url),
  "utf8",
);
const workflow = readFileSync(
  new URL("../../.github/workflows/terraform-deploy.yml", import.meta.url),
  "utf8",
);

// SQL with its `--` comments removed, so a rule about statements is not tripped by
// the prose that explains it.
function sqlOnly(text) {
  return text
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

const code = sqlOnly(up);

test("the migration is one transaction under a lock timeout, as the deploy expects", () => {
  assert.match(up, /^BEGIN;/m);
  assert.match(up, /^COMMIT;/m);
  assert.match(up, /SET LOCAL lock_timeout = '15s';/);
});

test("the suppression table is created IF NOT EXISTS, so a replay touches nothing", () => {
  assert.match(code, /CREATE TABLE IF NOT EXISTS alert_email_suppressions/);
});

test("the email_status CHECK is replaced only when the catalog lacks the new states", () => {
  // The guard reads the live constraint definition. A replay that finds the new
  // state already present must do nothing, so the DROP sits inside the IF.
  assert.match(code, /IF def IS NULL OR def NOT LIKE '%skipped_suppressed%' THEN/);
  const guarded = code.slice(code.indexOf("IF def IS NULL"));
  const dropAt = guarded.indexOf("DROP CONSTRAINT");
  const endAt = guarded.indexOf("END IF;");
  assert.ok(dropAt > 0 && dropAt < endAt, "the DROP must be inside the guard");
});

test("the replacement CHECK is added NOT VALID and then validated, so no full-table scan holds the lock", () => {
  assert.match(code, /NOT VALID;/);
  assert.match(code, /VALIDATE CONSTRAINT alert_events_email_status_check/);
});

test("the CHECK admits the eleven statuses the Go contract declares", () => {
  const check = code.match(/ADD CONSTRAINT alert_events_email_status_check CHECK \(email_status IN\s*\(([^)]*)\)\)/);
  assert.ok(check, "the replacement CHECK must be present");
  const states = [...check[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(states, [
    "awaiting_entitlement",
    "bounced",
    "complained",
    "failed",
    "pending",
    "sending",
    "sent",
    "skipped_no_email",
    "skipped_paused",
    "skipped_suppressed",
    "skipped_unentitled",
  ]);
});

test("the suppression table keys on the lower-cased address and names its reason", () => {
  assert.match(code, /email\s+TEXT PRIMARY KEY/);
  assert.match(code, /CHECK \(email = lower\(email\) AND email <> ''\)/);
  assert.match(code, /CHECK \(reason IN \('bounced', 'complained'\)\)/);
});

test("the migration touches no rows: it never UPDATEs or INSERTs or DELETEs", () => {
  assert.doesNotMatch(code, /\bUPDATE\s+\w/);
  assert.doesNotMatch(code, /\bINSERT\s+INTO\b/);
  assert.doesNotMatch(code, /\bDELETE\s+FROM\b/);
});

test("the down migration restores the 000147 list after folding the new states", () => {
  const dcode = sqlOnly(down);
  assert.match(dcode, /DROP TABLE IF EXISTS alert_email_suppressions/);
  assert.match(dcode, /SET email_status = 'failed'/);
  assert.match(dcode, /'awaiting_entitlement'\)\);/);
});

test("the deploy allowlist runs 000148 right after 000147", () => {
  const i147 = workflow.indexOf("-f /migrations/000147_add_alert_events.up.sql");
  const i148 = workflow.indexOf("-f /migrations/000148_add_email_suppression.up.sql");
  assert.ok(i147 > 0, "000147 must stay allowlisted");
  assert.ok(i148 > i147, "000148 must be allowlisted after 000147");
});
