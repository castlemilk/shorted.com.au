import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const up = readFileSync(
  new URL("./000106_add_senate_identity.up.sql", import.meta.url),
  "utf8",
);
const down = readFileSync(
  new URL("./000106_add_senate_identity.down.sql", import.meta.url),
  "utf8",
);
const rollups = readFileSync(
  new URL("./000104_add_register_explorer_rollups.up.sql", import.meta.url),
  "utf8",
);

/** Strip `--` comments so prose about a rule can't satisfy an assertion about SQL. */
const upCode = up.replace(/--.*$/gm, "");
const downCode = down.replace(/--.*$/gm, "");

/** The body of a named materialized view, comments stripped. */
function viewBody(code, name) {
  const start = code.indexOf(`CREATE MATERIALIZED VIEW ${name} AS`);
  assert.notEqual(start, -1, `materialized view ${name} not found`);
  const body = code.slice(start);
  const end = body.indexOf("\nCREATE UNIQUE INDEX");
  assert.notEqual(end, -1, `unterminated view body for ${name}`);
  return body.slice(0, end);
}

// ---------------------------------------------------------------------------
// The tiebreaker.
//
// `DISTINCT ON (politician_id) ... ORDER BY politician_id, parliament DESC` is
// NOT a total order: a person holding two terms in one parliament — a
// mid-parliament chamber transfer — gets an arbitrary one, and the arbitrary
// choice decides which CHAMBER is printed beside their declared holdings. The
// view has to be reproducible from identical data.
// ---------------------------------------------------------------------------
test("the latest-term pick is a total order, not just parliament DESC", () => {
  const body = viewBody(upCode, "mv_register_public_holdings");
  assert.match(
    body,
    /DISTINCT ON \(politician_id\)/,
    "the latest-term CTE must still pick one term per person",
  );
  assert.match(
    body,
    /ORDER BY politician_id,\s*parliament DESC,/,
    "the latest parliament must still win",
  );
  assert.match(
    body,
    /term_start DESC NULLS FIRST/,
    "within a parliament the later-starting term must win, and an undated register-derived term must not lose by default",
  );
  assert.match(
    body,
    /term_start DESC NULLS FIRST,\s*(--[^\n]*\n\s*)*chamber\b/,
    "chamber must be the final tiebreak, so the order is total",
  );
});

test("the rebuilt view keeps every column and index the read paths use", () => {
  const body = viewBody(upCode, "mv_register_public_holdings");
  for (const column of [
    "chamber",
    "division",
    "state_code AS member_state",
    "party",
    "party_ab",
    "stock_code",
    "entity_kind",
    "sal_code",
    "declared_from_known",
    "currently_declared",
    "source_licence",
  ]) {
    assert.ok(
      body.includes(column),
      `mv_register_public_holdings lost the ${column} column`,
    );
  }
  // The unique index is what lets REFRESH ... CONCURRENTLY run at all; losing
  // it turns every refresh into an exclusive lock on a published surface.
  assert.match(
    upCode,
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_register_public_holdings\s*\n?\s*ON mv_register_public_holdings\s*\n?\s*\(politician_id, item_no, holder, declared_text, declared_from\)/,
    "the unique index REFRESH CONCURRENTLY depends on is missing",
  );
  for (const index of [
    "idx_mv_register_public_holdings_stock",
    "idx_mv_register_public_holdings_sal",
    "idx_mv_register_public_holdings_slug",
  ]) {
    assert.ok(upCode.includes(index), `lost index ${index}`);
  }
});

// A materialized view's body cannot be replaced in place, so the two rollups
// that select FROM it have to be dropped and recreated. Recreating them wrong
// is how a rebuild silently changes a published count.
test("the dependent rollups are recreated, not left dropped", () => {
  for (const view of [
    "mv_register_politician_rollup",
    "mv_register_politician_monthly",
  ]) {
    assert.ok(
      upCode.includes(`DROP MATERIALIZED VIEW IF EXISTS ${view}`),
      `${view} must be dropped before the view it depends on`,
    );
    assert.ok(
      upCode.includes(`CREATE MATERIALIZED VIEW ${view} AS`),
      `${view} was dropped and never recreated`,
    );
  }
  // And recreated IDENTICALLY: this migration changes nothing about them, so
  // any drift is an accident.
  for (const view of [
    "mv_register_politician_rollup",
    "mv_register_politician_monthly",
  ]) {
    const before = viewBody(rollups.replace(/--.*$/gm, ""), view);
    for (const code of [upCode, downCode]) {
      assert.equal(
        viewBody(code, view).replace(/\s+/g, " ").trim(),
        before.replace(/\s+/g, " ").trim(),
        `${view} drifted from its 000104 definition`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Rule 3c's vocabulary.
// ---------------------------------------------------------------------------
test("the candidate resolution CHECK admits the senate method and nothing looser", () => {
  assert.match(
    upCode,
    /CHECK \(resolution_method IN \(\s*'unresolved', 'curated_alias', 'division_surname_given_exact',\s*'state_surname_given_exact'\)\)/,
    "the resolution CHECK must list exactly the four methods",
  );
  // A fuzzy method must never become storable by accident.
  for (const banned of ["fuzzy", "similar", "trigram", "levenshtein", "name_like"]) {
    assert.ok(
      !upCode.toLowerCase().includes(`'${banned}`),
      `a ${banned} resolution method reached the CHECK`,
    );
  }
});

test("aec_state_full_name is immutable and withholds on anything unrecognised", () => {
  assert.match(
    upCode,
    /CREATE OR REPLACE FUNCTION aec_state_full_name\(code TEXT\)[\s\S]*?IMMUTABLE/,
    "aec_state_full_name must be IMMUTABLE so it can be used in an index or a join",
  );
  assert.match(
    upCode,
    /ELSE ''\s*\n\s*END;/,
    "an unrecognised state code must return an empty string, so a comparison against it withholds",
  );
  for (const state of [
    "New South Wales",
    "Victoria",
    "Queensland",
    "South Australia",
    "Western Australia",
    "Tasmania",
    "Northern Territory",
    "Australian Capital Territory",
  ]) {
    assert.ok(upCode.includes(`'${state}'`), `aec_state_full_name is missing ${state}`);
  }
});

// ---------------------------------------------------------------------------
// Rule 5: no magnitude, ever. Asserted on every migration in this subsystem
// because the guarantee is that no such column exists ANYWHERE in it.
// ---------------------------------------------------------------------------
test("no amount, value or quantity column is introduced", () => {
  const banned =
    /\b(amount|value|quantity|worth|salary|balance|holding_size|portfolio)\b\s+(TEXT|NUMERIC|INTEGER|BIGINT|DECIMAL|SMALLINT|REAL|MONEY)/i;
  assert.ok(!banned.test(upCode), "a magnitude column reached the register subsystem");
  assert.ok(!banned.test(downCode), "a magnitude column reached the down migration");
});

// ---------------------------------------------------------------------------
// The down migration.
// ---------------------------------------------------------------------------
test("down releases the senate-resolved rows before narrowing the CHECK", () => {
  const release = downCode.indexOf("SET politician_id = NULL");
  const check = downCode.indexOf("ADD CONSTRAINT aec_candidate_returns_resolution_check");
  assert.notEqual(release, -1, "down must release rows resolved by the senate rule");
  assert.ok(
    release < check,
    "the rows must be released BEFORE the narrower CHECK is added, or it cannot be added at all",
  );
  // 000105 pairs the join and the method: releasing one without the other
  // violates its CHECK and its trigger.
  assert.match(
    downCode,
    /SET politician_id = NULL, resolution_method = 'unresolved'/,
    "the join and its method must be released together",
  );
});

test("down does not delete the identities the ingest minted", () => {
  assert.ok(
    !/DELETE\s+FROM\s+politicians/i.test(downCode),
    "a down migration must not delete people: slugs are minted once and never reassigned",
  );
  assert.ok(
    !/DELETE\s+FROM\s+politician_terms/i.test(downCode),
    "a down migration must not delete terms",
  );
});

test("down restores the pre-000106 view and its dependents", () => {
  const body = viewBody(downCode, "mv_register_public_holdings");
  assert.ok(
    !body.includes("term_start"),
    "the down view must be the pre-000106 definition",
  );
  assert.ok(downCode.includes("DROP FUNCTION IF EXISTS aec_state_full_name"));
});

test("both migrations are transactional", () => {
  for (const [name, code] of [["up", up], ["down", down]]) {
    assert.ok(code.includes("BEGIN;"), `${name} is not wrapped in a transaction`);
    assert.ok(code.trimEnd().endsWith("COMMIT;"), `${name} does not commit`);
  }
});
