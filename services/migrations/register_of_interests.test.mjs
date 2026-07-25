import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const up = readFileSync(
  new URL("./000096_add_register_of_interests.up.sql", import.meta.url),
  "utf8",
);
const down = readFileSync(
  new URL("./000096_add_register_of_interests.down.sql", import.meta.url),
  "utf8",
);

/** Strip `--` comments so prose about "value"/"amount" can't satisfy a column assertion. */
const upCode = up.replace(/--.*$/gm, "");

/** Body of a CREATE TABLE block, comments stripped. */
function tableBlock(name) {
  const start = upCode.indexOf(`CREATE TABLE IF NOT EXISTS ${name}`);
  assert.notEqual(start, -1, `table ${name} not found`);
  const body = upCode.slice(start);
  const end = body.indexOf("\n);");
  assert.notEqual(end, -1, `unterminated CREATE TABLE for ${name}`);
  return body.slice(0, end);
}

const FACT_TABLES = [
  "politicians",
  "politician_terms",
  "register_documents",
  "register_statements",
  "register_declared_items",
  "register_holding_periods",
];

// ---------------------------------------------------------------------------
// Editorial rule 5 — the registers disclose WHAT is held, never quantity/value.
// This is the single most important invariant in the subsystem: if a column
// implying magnitude ever lands here, every downstream surface can imply
// portfolio size or trading profit. See docs/influence-editorial-standards.md.
// ---------------------------------------------------------------------------
test("no column in any register table implies quantity, value or size (editorial rule 5)", () => {
  // Column definitions look like `  name TYPE ...` at the start of a line.
  //
  // BOOLEAN is deliberately absent from the type list: the invariant is that no
  // column can STORE a magnitude, and a flag cannot. That exempts
  // register_declared_items.contains_amount, which is a vision-tier review
  // flag ("the model thought this cell held a figure") and is never published.
  const banned =
    /^\s*\w*(amount|value|quantity|qty|units?|shares?|price|worth|balance|holding_size|market_cap|dollars?)\w*\s+(TEXT|NUMERIC|INTEGER|BIGINT|SMALLINT|DOUBLE|DECIMAL|MONEY|REAL|VARCHAR)/im;
  for (const t of [
    ...FACT_TABLES,
    "register_item_securities",
    "register_item_locations",
    "register_security_aliases",
    "register_extractions",
  ]) {
    assert.doesNotMatch(
      tableBlock(t),
      banned,
      `${t} declares a column implying quantity or value`,
    );
  }
});

test("contains_amount is a review flag only, and documented as never published", () => {
  assert.match(tableBlock("register_declared_items"), /contains_amount\s+BOOLEAN/i);
  assert.match(
    up,
    /COMMENT ON COLUMN register_declared_items\.contains_amount[\s\S]*[Nn]ever rendered publicly/,
  );
});

// ---------------------------------------------------------------------------
// User decision: all three holders are ingested AND published, each labelled.
// ---------------------------------------------------------------------------
test("all three holders are modelled and labelled", () => {
  const holders = /holder IN \('self','spouse_partner','dependent_children','unspecified'\)/;
  assert.match(tableBlock("register_declared_items"), holders);
  assert.match(tableBlock("register_holding_periods"), holders);
});

// ---------------------------------------------------------------------------
// Alterations are event-sourced deltas (verified against Gorman_47P.pdf: one
// base statement + 10 dated NOTIFICATION OF ALTERATION forms with explicit
// ADDITION / DELETION sections).
// ---------------------------------------------------------------------------
test("alterations are modelled as add/remove events, not snapshots", () => {
  assert.match(
    tableBlock("register_declared_items"),
    /change_type IN \('declared','addition','deletion'\)/,
  );
  assert.match(
    tableBlock("register_statements"),
    /statement_kind IN \('base','alteration'\)/,
  );
});

test("holding periods are intervals that can be open-ended or unknown-start", () => {
  const block = tableBlock("register_holding_periods");
  assert.match(block, /declared_from\s+DATE/i);
  assert.match(block, /declared_to\s+DATE/i);
  assert.match(block, /declared_from_known\s+BOOLEAN/i);
  // An interval must never end before it starts.
  assert.match(block, /declared_to IS NULL OR declared_from IS NULL OR declared_to >= declared_from/);
  // Never fabricate a start date for holdings that predate the extraction window.
  assert.match(
    up,
    /COMMENT ON COLUMN register_holding_periods\.declared_from_known[\s\S]*never fabricate a date/i,
  );
});

// ---------------------------------------------------------------------------
// Entity-resolution gate. Editorial standards §2: fuzzy name matches are
// analyst-only, never public. Enforced by a CHECK so a buggy read-path query
// still cannot leak one.
// ---------------------------------------------------------------------------
test("a fuzzy security match can never be 'resolved' (structural public gate)", () => {
  const block = tableBlock("register_item_securities");
  assert.match(block, /analyst_fuzzy/);
  assert.match(
    block,
    /register_item_securities_public_gate[\s\S]*resolution_status <> 'resolved'[\s\S]*match_method IN \('curated_alias','name_exact'\)/,
  );
  // The gate must also require a code, or "resolved with no ticker" slips through.
  assert.match(
    block,
    /register_item_securities_public_gate[\s\S]*stock_code IS NOT NULL/,
  );
});

test("an unlisted managed fund resolves without a stock code, and a resolved alias requires one", () => {
  const block = tableBlock("register_security_aliases");
  assert.match(block, /alias_kind IN \('equity','etf','lic','managed_fund','foreign','noise'\)/);
  assert.match(block, /resolution IN \('resolved','unlisted_fund','not_a_security'\)/);
  assert.match(
    block,
    /register_security_aliases_resolved_needs_code[\s\S]*resolution <> 'resolved' OR stock_code IS NOT NULL/,
  );
});

test("a resolved property location requires a sal_code, and ambiguity is recorded not guessed", () => {
  const block = tableBlock("register_item_locations");
  assert.match(
    block,
    /resolution_status IN \('resolved','ambiguous','region','no_state','unmatched'\)/,
  );
  assert.match(
    block,
    /register_item_locations_resolved_needs_sal[\s\S]*resolution_status <> 'resolved' OR sal_code IS NOT NULL/,
  );
  assert.match(block, /candidate_count\s+SMALLINT/i);
});

// ---------------------------------------------------------------------------
// Provenance. Licence requires attribution + an as-at date on every published
// fact, and forbids mirroring the PDFs.
// ---------------------------------------------------------------------------
test("every fact table carries source provenance", () => {
  for (const t of FACT_TABLES) {
    const block = tableBlock(t);
    for (const col of ["source_url", "source_licence", "fetched_at"]) {
      assert.ok(block.includes(col), `${t} is missing ${col}`);
    }
  }
});

test("the private PDF cache is documented as never reaching a read path", () => {
  assert.match(tableBlock("register_documents"), /storage_uri\s+TEXT/i);
  assert.match(
    up,
    /COMMENT ON COLUMN register_documents\.storage_uri[\s\S]*[Nn]ever expose on a read path/,
  );
});

test("the source is registered but stays non-public until the editorial review passes", () => {
  assert.match(up, /INSERT INTO industry_intelligence_sources/);
  assert.match(up, /'aph-register-of-interests'/);
  // signal_kind + collection_method must be values the existing CHECKs allow.
  assert.match(up, /'policy_footprint'/);
  assert.match(up, /'html'/);
  // enabled TRUE, public_enabled FALSE, exact_entity_required TRUE — in that order.
  assert.match(up, /TRUE,\s*(?:--[^\n]*\n\s*)?FALSE,\s*(?:--[^\n]*\n\s*)?TRUE,/);
  // A re-run must not clobber a hand-flipped public_enabled.
  const conflict = up.slice(up.indexOf("ON CONFLICT (source_key) DO UPDATE"));
  assert.doesNotMatch(
    conflict,
    /public_enabled/,
    "the upsert must not reset public_enabled — that would silently re-dark or re-publish the source",
  );
});

// ---------------------------------------------------------------------------
// MV refresh hardening. plpgsql's WHEN OTHERS does NOT match query_canceled
// (57014), which is exactly what a statement_timeout raises — the failure mode
// that starved 5 MVs for 19 days (see 000095_harden_mv_refresh.up.sql).
// ---------------------------------------------------------------------------
test("register MV refresh catches statement_timeout, not just OTHERS", () => {
  for (const mv of ["mv_register_public_holdings", "mv_register_suburb_property"]) {
    assert.match(
      up,
      new RegExp(
        `REFRESH MATERIALIZED VIEW CONCURRENTLY ${mv};[\\s\\S]*?EXCEPTION WHEN query_canceled OR OTHERS THEN[\\s\\S]*?REFRESH MATERIALIZED VIEW ${mv};`,
      ),
      `${mv} lacks a query_canceled-aware fallback`,
    );
  }
  // A bare `WHEN OTHERS` guard would silently reintroduce the 000095 bug.
  assert.doesNotMatch(
    upCode,
    /EXCEPTION WHEN OTHERS THEN\s*\n\s*REFRESH MATERIALIZED VIEW/,
    "found a bare WHEN OTHERS guard around a REFRESH; it cannot catch query_canceled",
  );
  assert.match(
    up,
    /ALTER FUNCTION refresh_register_materialized_views\(\) SET statement_timeout TO '0'/,
  );
});

test("both register MVs are concurrently refreshable", () => {
  // REFRESH ... CONCURRENTLY requires a unique index on the MV.
  assert.match(
    up,
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_register_public_holdings[\s\S]*?\(politician_id, item_no, holder, declared_text, declared_from\)/,
  );
  assert.match(
    up,
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_register_suburb_property[\s\S]*?\(sal_code\)/,
  );
});

test("the public MV excludes merged duplicate people", () => {
  const mv = up.slice(
    up.indexOf("CREATE MATERIALIZED VIEW mv_register_public_holdings"),
  );
  assert.match(mv, /p\.merged_into_id IS NULL/);
});

test("the suburb-property MV is keyed on sal_code so the choropleth is never a per-request join", () => {
  const mv = up.slice(
    up.indexOf("CREATE MATERIALIZED VIEW mv_register_suburb_property"),
    up.indexOf("CREATE OR REPLACE VIEW register_resolution_stats"),
  );
  assert.match(mv, /WHERE hp\.item_no = 3/);
  assert.match(mv, /hp\.sal_code IS NOT NULL/);
  assert.match(mv, /declaring_member_count/);
  assert.match(mv, /p\.merged_into_id IS NULL/);
});

// ---------------------------------------------------------------------------
// Observability: the extraction tripwire and the curation worklists.
// ---------------------------------------------------------------------------
test("extraction stats expose per-item nil rates (the broken-parser tripwire)", () => {
  const view = up.slice(up.indexOf("CREATE OR REPLACE VIEW register_extraction_stats"));
  assert.match(view, /nil_pct/);
  assert.match(view, /rows_flagged_amount/);
  assert.match(view, /GROUP BY 1,2,3/);
});

test("resolution backlogs exist and are ordered as worklists", () => {
  for (const v of ["register_resolution_backlog", "register_location_backlog"]) {
    const view = up.slice(up.indexOf(`CREATE OR REPLACE VIEW ${v}`));
    assert.match(view, /ORDER BY occurrences DESC/, `${v} is not ordered as a worklist`);
  }
});

// ---------------------------------------------------------------------------
// Identity. Same-surname members across 5 parliaments are the worst failure
// mode in this domain: a collision silently merges two people's interests.
// ---------------------------------------------------------------------------
test("identity is a person with many terms, not keyed off a filename", () => {
  const p = tableBlock("politicians");
  assert.match(p, /person_key\s+TEXT NOT NULL UNIQUE/i);
  assert.match(p, /merged_into_id\s+UUID REFERENCES politicians\(id\)/i);
  assert.match(p, /politicians_no_self_merge/);
  // aph_mpid is opportunistic: nullable, but unique where present.
  assert.match(p, /aph_mpid\s+TEXT,/i);
  assert.match(
    up,
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_politicians_aph_mpid[\s\S]*?WHERE aph_mpid IS NOT NULL/,
  );
  // Filenames are audit-only and must never derive identity.
  assert.match(tableBlock("politician_aliases"), /'filename'/);
  assert.match(tableBlock("politician_terms"), /UNIQUE \(politician_id, parliament, chamber\)/);
});

test("slugs are unique and documented as never reassigned", () => {
  assert.match(tableBlock("politicians"), /slug\s+TEXT NOT NULL UNIQUE/i);
  assert.match(
    up,
    /COMMENT ON COLUMN politicians\.slug[\s\S]*never reassigned/i,
  );
});

// ---------------------------------------------------------------------------
// Manifest-as-cursor: re-running a mode must be a no-op.
// ---------------------------------------------------------------------------
test("the document manifest is the crawl cursor and is idempotent on source_url", () => {
  const block = tableBlock("register_documents");
  assert.match(block, /source_url\s+TEXT NOT NULL UNIQUE/i);
  for (const col of ["fetch_status", "classify_status", "extract_status"]) {
    assert.ok(block.includes(col), `manifest is missing ${col}`);
  }
  // A 403 is a real signal (WAF policy change), so it needs its own terminal state.
  assert.match(block, /fetch_status IN \('pending','fetched','failed','blocked','skipped'\)/);
  assert.match(block, /http_status\s+SMALLINT/i);
});

test("extraction artifacts are content-addressed and versioned so a parser upgrade is non-destructive", () => {
  assert.match(
    tableBlock("register_extractions"),
    /UNIQUE \(content_sha256, extractor_version, tier\)/,
  );
});

// ---------------------------------------------------------------------------
// Reversibility.
// ---------------------------------------------------------------------------
test("down migration removes every object the up migration creates", () => {
  for (const t of [
    ...FACT_TABLES,
    "politician_aliases",
    "register_extractions",
    "register_item_securities",
    "register_item_locations",
    "register_security_aliases",
  ]) {
    assert.match(down, new RegExp(`DROP TABLE IF EXISTS ${t};`), `down leaves ${t}`);
  }
  for (const mv of ["mv_register_public_holdings", "mv_register_suburb_property"]) {
    assert.match(down, new RegExp(`DROP MATERIALIZED VIEW IF EXISTS ${mv};`));
  }
  for (const v of [
    "register_resolution_stats",
    "register_resolution_backlog",
    "register_location_backlog",
    "register_extraction_stats",
  ]) {
    assert.match(down, new RegExp(`DROP VIEW IF EXISTS ${v};`));
  }
  assert.match(down, /DROP FUNCTION IF EXISTS refresh_register_materialized_views\(\);/);
  assert.match(down, /DELETE FROM industry_intelligence_sources/);
});

test("down migration drops children before parents", () => {
  const at = (needle) => down.indexOf(needle);
  // politicians is referenced by aliases/terms/holding_periods.
  assert.ok(at("DROP TABLE IF EXISTS register_holding_periods;") < at("DROP TABLE IF EXISTS politicians;"));
  assert.ok(at("DROP TABLE IF EXISTS politician_terms;") < at("DROP TABLE IF EXISTS politicians;"));
  assert.ok(at("DROP TABLE IF EXISTS politician_aliases;") < at("DROP TABLE IF EXISTS politicians;"));
  // register_documents is referenced by extractions/statements.
  assert.ok(at("DROP TABLE IF EXISTS register_statements;") < at("DROP TABLE IF EXISTS register_documents;"));
  assert.ok(at("DROP TABLE IF EXISTS register_extractions;") < at("DROP TABLE IF EXISTS register_documents;"));
  // declared_items is referenced by securities/locations.
  assert.ok(at("DROP TABLE IF EXISTS register_item_securities;") < at("DROP TABLE IF EXISTS register_declared_items;"));
  assert.ok(at("DROP TABLE IF EXISTS register_item_locations;") < at("DROP TABLE IF EXISTS register_declared_items;"));
  // The MVs read the tables, so they must go first.
  assert.ok(at("DROP MATERIALIZED VIEW IF EXISTS mv_register_public_holdings;") < at("DROP TABLE IF EXISTS register_holding_periods;"));
});
