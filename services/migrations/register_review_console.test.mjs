import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

const up = read("./000101_add_register_review_console.up.sql");
const down = read("./000101_add_register_review_console.down.sql");
const base = read("./000096_add_register_of_interests.up.sql");
const proposeGo = read(
  "../jobs/internal/jobs/influence/aph_alias_propose.go",
);

/** Strip `--` comments so prose can't satisfy a code assertion. */
const strip = (sql) => sql.replace(/--.*$/gm, "");
const upCode = strip(up);
const baseCode = strip(base);

/** Column names declared in a CREATE TABLE block. */
function tableColumns(sql, name) {
  const start = sql.indexOf(`CREATE TABLE IF NOT EXISTS ${name}`);
  assert.notEqual(start, -1, `table ${name} not found`);
  const body = sql.slice(start + `CREATE TABLE IF NOT EXISTS ${name}`.length);
  const end = body.indexOf("\n);");
  assert.notEqual(end, -1, `unterminated CREATE TABLE for ${name}`);
  return body
    .slice(0, end)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^\w+\s+[A-Z]/.test(l) && !/^(CONSTRAINT|CHECK|PRIMARY|UNIQUE|FOREIGN)\b/i.test(l))
    .map((l) => l.split(/\s+/)[0].toLowerCase());
}

// ---------------------------------------------------------------------------
// THE BUG THIS FILE EXISTS FOR.
//
// promoteAliasProposals is the ONLY path from a human-confirmed proposal to a
// published link, and it shipped writing a column named `notes` into a table
// whose column is `note`. It had no test, and it could not fail in practice
// because nothing had ever been confirmed — there was no UI to confirm with. The
// moment the console existed, the first decision an operator made would have
// been the first execution of that statement.
//
// Asserting the Go INSERT against the migration's own column list is the check
// that generalises: any future column rename or added field is caught here
// rather than by an operator mid-review.
// ---------------------------------------------------------------------------
test("every column promoteAliasProposals writes exists on register_security_aliases", () => {
  const declared = tableColumns(baseCode, "register_security_aliases");
  assert.ok(declared.includes("note"), "fixture check: the column is `note`");

  const inserts = [
    ...strip(proposeGo).matchAll(
      /INSERT INTO register_security_aliases\s*\(([^)]*)\)/gi,
    ),
  ];
  assert.ok(inserts.length > 0, "no INSERT INTO register_security_aliases found");

  for (const m of inserts) {
    for (const col of m[1].split(",").map((c) => c.trim().toLowerCase()).filter(Boolean)) {
      assert.ok(
        declared.includes(col),
        `promoteAliasProposals writes ${col}, which register_security_aliases does not declare (columns: ${declared.join(", ")})`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

test("the review queue states blast radius in named people", () => {
  assert.match(
    upCode,
    /CREATE OR REPLACE VIEW register_review_security_queue/,
    "queue view missing",
  );
  assert.match(
    upCode,
    /count\(DISTINCT i\.politician_id\)\s+AS people/,
    "the queue must count distinct politicians: one alias fans out to N named people",
  );
});

test("the queue is NOT restricted to entity_kind='listed' (the §8.19.1 regression)", () => {
  // Filtering the queue to 'listed' is what made 1,301 names invisible to the
  // one lever that raises resolution — the cell-context rule moves unmatched
  // item-1 candidates to 'not_an_entity', and those are precisely the names a
  // human should see.
  const view = upCode.slice(
    upCode.indexOf("CREATE OR REPLACE VIEW register_review_security_queue"),
  );
  const body = view.slice(0, view.indexOf(";"));
  assert.match(
    body,
    /entity_kind IN \('listed',\s*'not_an_entity'\)/,
    "the queue must include not_an_entity candidates",
  );
});

test("a decided candidate leaves the queue via the alias table, not a second state store", () => {
  const view = upCode.slice(
    upCode.indexOf("CREATE OR REPLACE VIEW register_review_security_queue"),
  );
  assert.match(
    view.slice(0, view.indexOf(";")),
    /NOT EXISTS[\s\S]*register_security_aliases/,
    "the queue must exclude names register_security_aliases already decides",
  );
});

// ---------------------------------------------------------------------------
// Suppression is not deletion
// ---------------------------------------------------------------------------

test("row-level takedown adds suppressed_at and never deletes a declared row", () => {
  assert.match(upCode, /ADD COLUMN IF NOT EXISTS suppressed_at\s+TIMESTAMPTZ/i);
  assert.doesNotMatch(
    upCode,
    /DELETE\s+FROM\s+register_declared_items/i,
    "takedown must suppress, never delete: the row is a real declaration by a named person",
  );
});

test("suppression records who and why", () => {
  for (const col of ["suppressed_by", "suppression_note"]) {
    assert.match(upCode, new RegExp(`ADD COLUMN IF NOT EXISTS ${col}\\b`, "i"));
  }
});

// ---------------------------------------------------------------------------
// Editorial rule 5 — no column may imply magnitude, in ANY new register table.
// ---------------------------------------------------------------------------

test("000101 introduces no column implying quantity or value (editorial rule 5)", () => {
  const banned =
    /^\s*\w*(amount|value|quantity|qty|units?|shares?|price|worth|balance|market_cap|dollars?)\w*\s+(TEXT|NUMERIC|INTEGER|BIGINT|SMALLINT|DOUBLE|DECIMAL|MONEY|REAL|VARCHAR)/im;
  assert.doesNotMatch(upCode, banned, "000101 declares a column implying magnitude");
});

// ---------------------------------------------------------------------------
// 'foreign' becomes recordable
// ---------------------------------------------------------------------------

test("a curated alias may resolve as 'foreign'", () => {
  assert.match(
    upCode,
    /CHECK \(resolution IN \('resolved', 'unlisted_fund', 'not_a_security', 'foreign'\)\)/,
  );
});

test("the down migration preserves foreign decisions instead of dropping them", () => {
  const d = strip(down);
  assert.match(
    d,
    /UPDATE register_security_aliases[\s\S]*SET resolution = 'not_a_security'[\s\S]*WHERE resolution = 'foreign'/,
    "down-migrating must rewrite foreign aliases, not violate the narrowed CHECK or lose a human decision",
  );
  // The rewrite has to happen BEFORE the CHECK is narrowed, or it fails.
  assert.ok(
    d.indexOf("WHERE resolution = 'foreign'") <
      d.indexOf("ADD CONSTRAINT register_security_aliases_resolution_check"),
    "the foreign rewrite must precede the narrowed CHECK",
  );
});

// ---------------------------------------------------------------------------
// Up/down symmetry
// ---------------------------------------------------------------------------

test("the down migration reverses everything the up migration creates", () => {
  const d = strip(down);
  assert.match(d, /DROP VIEW IF EXISTS register_review_security_queue/);
  assert.match(d, /DROP TABLE IF EXISTS register_review_skips/);
  assert.match(d, /DROP INDEX IF EXISTS idx_register_items_suppressed/);
  for (const col of ["suppressed_at", "suppressed_by", "suppression_note"]) {
    assert.match(d, new RegExp(`DROP COLUMN IF EXISTS ${col}\\b`, "i"));
  }
});
