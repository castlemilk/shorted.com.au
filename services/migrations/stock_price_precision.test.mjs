// node --test services/migrations/stock_price_precision.test.mjs
//
// 000131 rewrites stock_prices and rebuilds every view that reads it, from the
// views' own catalog definitions, because prod's are not guaranteed to match
// this repository. These pin what makes that safe to hand-apply and to apply
// twice. The behaviour itself (views back with their indexes, grants, comments
// and data; refusal on a trigger, rule or column grant) is exercised against
// Postgres by TestPricePrecisionMigration in
// services/jobs/internal/jobs/marketdata/sync/sync_db_test.go.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (name) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
const up = read("000131_widen_stock_price_precision.up.sql");
const down = read("000131_widen_stock_price_precision.down.sql");
const workflow = readFileSync(new URL("../../.github/workflows/terraform-deploy.yml", import.meta.url), "utf8");

/** SQL with `--` comments removed, so prose never satisfies an assertion. */
const code = (sql) => sql.replace(/--.*$/gm, "");

test("each direction is one transaction that cannot time out mid-rewrite", () => {
  for (const sql of [up, down]) {
    const c = code(sql).trim();
    assert.ok(c.startsWith("BEGIN;"), "the whole migration is one transaction");
    assert.ok(c.endsWith("COMMIT;"));
    assert.match(c, /SET LOCAL statement_timeout = 0;/, "the role's default timeout would kill the rewrite");
    assert.match(c, /SET LOCAL lock_timeout = '\d+s';/, "waiting forever for a lock would stall every reader queued behind it");
  }
});

test("a replay does nothing", () => {
  for (const [sql, target, precision, scale] of [
    [up, "numeric(12,4)", 12, 4],
    [down, "numeric(10,2)", 10, 2],
  ]) {
    const c = code(sql);
    assert.ok(c.includes(`target      constant text   := '${target}';`));
    assert.ok(c.includes(`target_prec constant int    := ${precision};`));
    assert.ok(c.includes(`target_scale constant int   := ${scale};`));
    assert.match(c, /IF \(SELECT numeric_precision = target_prec AND numeric_scale = target_scale/);
    assert.match(c, /nothing to do', target;\s*\n\s*RETURN;/);
  }
});

test("dependent views are carried over, never cascaded away", () => {
  const c = code(up);
  assert.doesNotMatch(c, /\bCASCADE\b/i, "a cascade would drop what depends on the views without a word");
  assert.match(c, /pg_get_viewdef\(c\.oid\)/, "views are rebuilt from prod's own definitions");
  for (const carried of ["indexes", "relacl", "comment", "column_comments", "owner", "reloptions", "populated"]) {
    assert.ok(c.includes(carried), `a recreated view keeps its ${carried}`);
  }
  for (const refusal of ["has a trigger", "has a rule", "column-level grant"]) {
    assert.ok(c.includes(refusal), `what recreating cannot carry stops the migration: ${refusal}`);
  }
  assert.match(c, /ORDER BY depth DESC/, "dropped deepest first");
  assert.match(c, /ORDER BY depth, relname/, "recreated shallowest first");
});

test("the two directions differ only in the target type", () => {
  const body = (sql) =>
    code(sql.slice(sql.indexOf("BEGIN;")))
      .split("\n")
      .filter((line) => !/^\s*target(_prec|_scale)?\s+constant/.test(line))
      .join("\n");
  assert.equal(body(up), body(down));
});

test("it is applied by hand, never replayed by a deploy", () => {
  assert.ok(
    !workflow.includes("000131_widen_stock_price_precision"),
    "a table rewrite and a rebuild of the price views must not run inside a deploy",
  );
  assert.match(up, /task db:prod:apply FILE=services\/migrations\/000131_widen_stock_price_precision\.up\.sql CONFIRM=prod/);
});
