// node --test services/migrations/strategy_capture.test.mjs
//
// 000154 is the forward point-in-time capture: the ASIC report ingest log, the ASIC
// revision log and the stock_fundamentals vintage history. Prod replays every allowlisted migration on
// every deploy, so the file must be replay-safe, touch no row outside its guarded baseline, grant nothing,
// and sit in the allowlist between 000153 and the 000138 closer. The container test in
// services/jobs/internal/jobs/shortdatasync runs it against a live Postgres.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const up = readFileSync(new URL("./000154_strategy_capture.up.sql", import.meta.url), "utf8");
const down = readFileSync(new URL("./000154_strategy_capture.down.sql", import.meta.url), "utf8");
const workflow = readFileSync(
  new URL("../../.github/workflows/terraform-deploy.yml", import.meta.url),
  "utf8",
);

// SQL with its `--` comments removed, so a rule about statements is not tripped by prose.
function sqlOnly(text) {
  return text
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

// The body of a dollar-quoted DO block, by its tag.
function doBlock(tag) {
  const match = up.match(new RegExp(`DO \\$${tag}\\$([\\s\\S]*?)\\$${tag}\\$;`));
  assert.ok(match, `missing DO block ${tag}`);
  return match[1];
}

const code = sqlOnly(up);
const flat = code.replace(/\s+/g, " ");

test("the file is one transaction under a short lock timeout", () => {
  assert.match(up, /^BEGIN;/m);
  assert.match(up, /^COMMIT;/m);
  assert.match(up, /SET LOCAL lock_timeout = '5s';/);
  assert.ok(up.indexOf("SET LOCAL lock_timeout") < up.indexOf("CREATE TABLE IF NOT EXISTS asic_report_ingests"));
});

test("every CREATE TABLE is replay-safe, and the three tables exist", () => {
  const creates = [...code.matchAll(/^CREATE TABLE\b[^\n]*/gim)].map((m) => m[0]);
  assert.equal(creates.length, 3);
  for (const statement of creates) {
    assert.match(statement, /IF NOT EXISTS/i, `not replay-safe: ${statement}`);
  }
  for (const name of ["asic_report_ingests", "shorts_revisions", "stock_fundamentals_vintages"]) {
    assert.match(code, new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\(`));
  }
});

test("asic_report_ingests keys on the report date and keeps first_ingested_at and the first mode", () => {
  assert.match(flat, /report_date DATE PRIMARY KEY/);
  assert.match(flat, /first_ingested_at TIMESTAMPTZ NOT NULL DEFAULT now\(\)/);
  assert.match(flat, /last_ingested_at TIMESTAMPTZ NOT NULL DEFAULT now\(\)/);
  assert.match(flat, /file_rows INTEGER,/);
  assert.match(flat, /loaded_rows INTEGER NOT NULL,/);
  assert.match(flat, /mode TEXT NOT NULL CONSTRAINT asic_report_ingests_mode_check CHECK \(mode IN \('daily', 'poll', 'reconcile'\)\)/);
  assert.match(flat, /last_mode TEXT NOT NULL CONSTRAINT asic_report_ingests_last_mode_check CHECK \(last_mode IN \('daily', 'poll', 'reconcile'\)\)/);
});

test("the vintage op admits baseline, insert, update and delete only", () => {
  const check = code.match(/CHECK \(op IN \(([^)]*)\)\)/);
  assert.ok(check, "op must carry a CHECK");
  const ops = [...check[1].matchAll(/'([A-Z])'/g)].map((m) => m[1]).sort();
  assert.deepEqual(ops, ["B", "D", "I", "U"]);
});

test("the vintage table records the row without its provenance timestamps", () => {
  assert.match(flat, /row_json JSONB NOT NULL/);
  assert.equal((code.match(/- 'updated_at' - 'source_fetched_at'/g) ?? []).length >= 4, true,
    "every vintage row strips updated_at and source_fetched_at");
});

test("no table or index names a role, and nothing grants, owns, polices or secures", () => {
  for (const pattern of [
    /\bGRANT\b/i,
    /\bREVOKE\b/i,
    /\bOWNER TO\b/i,
    /\bCREATE POLICY\b/i,
    /\bROW LEVEL SECURITY\b/i,
    /\bFORCE\b/i,
    /\bSECURITY DEFINER\b/i,
    /\banon\b|\bauthenticated\b|\bPUBLIC\b/,
  ]) {
    assert.doesNotMatch(code, pattern, `must not match ${pattern}`);
  }
});

test("every index is created only when the catalog lacks it", () => {
  const unguarded = code.replace(/EXECUTE '[^']*'/g, "");
  assert.doesNotMatch(
    unguarded.replace(/DO \$[a-z0-9_]+\$[\s\S]*?\$[a-z0-9_]+\$;/g, ""),
    /CREATE (UNIQUE )?INDEX/i,
    "CREATE INDEX must sit inside a guarded DO block",
  );
  for (const [tag, name, table] of [
    ["m154_idx_revisions", "idx_shorts_revisions_code_date", "shorts_revisions \\(product_code, report_date\\)"],
    ["m154_idx_vintages", "idx_sfv_key_time", "stock_fundamentals_vintages \\(stock_code, period_type, period_end, captured_at, id\\)"],
  ]) {
    const block = doBlock(tag);
    assert.match(block, new RegExp(`to_regclass\\('public\\.${name}'\\) IS NULL`));
    assert.match(block, new RegExp(`CREATE INDEX ${name} ON ${table}`));
  }
});

test("the trigger is created only when pg_trigger lacks it, and fires after each row change", () => {
  const block = doBlock("m154_trigger");
  assert.match(block, /FROM pg_trigger/);
  assert.match(block, /tgname = 'trg_fundamentals_vintage'/);
  assert.match(block, /NOT tgisinternal/);
  assert.match(
    block,
    /CREATE TRIGGER trg_fundamentals_vintage\s+AFTER INSERT OR UPDATE OR DELETE ON stock_fundamentals\s+FOR EACH ROW EXECUTE FUNCTION record_fundamentals_vintage\(\);/,
  );
  assert.doesNotMatch(code, /CREATE TRIGGER[^]*?ON shorts\b/, "no trigger may touch the shorts table");
});

test("the function records deletes as D, skips no-op updates and is replaced, not dropped", () => {
  assert.match(code, /CREATE OR REPLACE FUNCTION record_fundamentals_vintage\(\) RETURNS trigger/);
  assert.match(flat, /IF TG_OP = 'DELETE' THEN .* VALUES \(OLD\.stock_code, OLD\.period_type, OLD\.period_end, 'D',/);
  assert.match(flat, /IF TG_OP = 'UPDATE' AND \(to_jsonb\(OLD\) - 'updated_at' - 'source_fetched_at'\) = newj THEN RETURN NEW;/);
  assert.match(flat, /CASE WHEN TG_OP = 'INSERT' THEN 'I' ELSE 'U' END/);
  assert.doesNotMatch(code, /DROP FUNCTION/i);
});

test("the baseline runs only into an empty vintage table, under a lock on the source", () => {
  const block = doBlock("m154_baseline");
  assert.match(block, /IF NOT EXISTS \(SELECT 1 FROM stock_fundamentals_vintages\)/);
  assert.match(block, /LOCK TABLE stock_fundamentals IN SHARE ROW EXCLUSIVE MODE;/);
  assert.match(block, /INSERT INTO stock_fundamentals_vintages[\s\S]*SELECT f\.stock_code, f\.period_type, f\.period_end, 'B', to_jsonb\(f\) - 'updated_at' - 'source_fetched_at'/);
});

test("every INSERT sits inside a guarded block, and nothing updates, deletes or truncates a row", () => {
  // The function body's INSERTs are the trigger's own writes; the baseline is guarded above.
  const outsideFunction = code.replace(/CREATE OR REPLACE FUNCTION[\s\S]*?END \$f\$;/, "");
  const inserts = [...outsideFunction.matchAll(/INSERT INTO/g)].length;
  const guardedInserts = [...doBlock("m154_baseline").matchAll(/INSERT INTO/g)].length;
  assert.equal(inserts, guardedInserts, "the only INSERT outside the function is the guarded baseline");
  assert.doesNotMatch(code, /\bUPDATE\s+\w+\s+SET\b/i);
  assert.doesNotMatch(code, /\bDELETE FROM\b/i);
  assert.doesNotMatch(code, /\bTRUNCATE\b/i);
});

test("the down migration drops only what the up migration creates, guarded by IF EXISTS", () => {
  assert.match(down, /^BEGIN;/m);
  assert.match(down, /^COMMIT;/m);
  for (const statement of sqlOnly(down).matchAll(/^DROP [^\n;]*/gim)) {
    assert.match(statement[0], /IF EXISTS/i, `not guarded: ${statement[0]}`);
  }
  assert.doesNotMatch(sqlOnly(down), /\bGRANT\b/i);
});

test("the allowlist runs 000154 after 000153 and before the 000138 closer", () => {
  const line = "run_psql_session -f /migrations/000154_strategy_capture.up.sql";
  // Counts the allowlist command, not the path: the workflow comment also names the file for the manual apply.
  assert.equal(workflow.split(line).length - 1, 1, "allowlisted once");
  const at = workflow.indexOf(line);
  assert.ok(at > 0, "000154 must be in the allowlist, or it never reaches prod");
  assert.ok(at > workflow.indexOf("run_psql_session -f /migrations/000153_add_crawl_ops_indexes.up.sql"));
  assert.ok(at < workflow.indexOf("run_psql_session -f /migrations/000138_harden_data_api_grants.up.sql"));
});
