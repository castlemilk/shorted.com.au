import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const up = readFileSync(
  new URL("./000105_add_aec_donations.up.sql", import.meta.url),
  "utf8",
);
const down = readFileSync(
  new URL("./000105_add_aec_donations.down.sql", import.meta.url),
  "utf8",
);

/** Strip `--` comments so prose about a rule can never satisfy an assertion. */
const upCode = up.replace(/--.*$/gm, "");
const downCode = down.replace(/--.*$/gm, "");

/** Body of a CREATE TABLE block, comments stripped. */
function tableBody(name) {
  const start = upCode.indexOf(`CREATE TABLE IF NOT EXISTS ${name} (`);
  assert.notEqual(start, -1, `table ${name} not found`);
  const body = upCode.slice(start);
  const end = body.indexOf("\n);");
  assert.notEqual(end, -1, `unterminated table body for ${name}`);
  return body.slice(0, end);
}

const TABLES = [
  "aec_party_returns",
  "aec_receipts",
  "aec_donations_made",
  "aec_mp_returns",
  "aec_candidate_returns",
  "aec_candidate_donations",
  "aec_entity_aliases",
];

/** Every `column_name TYPE` declaration in a table body. */
function columns(name) {
  return tableBody(name)
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line &&
        !line.startsWith("CREATE") &&
        !line.startsWith("CONSTRAINT") &&
        !line.startsWith("UNIQUE") &&
        !line.startsWith("CHECK") &&
        !line.startsWith("PRIMARY"),
    )
    .map((line) => {
      const m = line.match(/^([a-z_]+)\s+([A-Za-z]+(?:\s*\([^)]*\))?)/);
      return m ? { name: m[1], type: m[2].toUpperCase().replace(/\s+/g, "") } : null;
    })
    .filter(Boolean);
}

test("every aec_ table the plan names exists", () => {
  for (const t of TABLES) tableBody(t);
});

// ---------------------------------------------------------------------------
// Amounts are integer cents. AEC data publishes whole dollars, so a float or a
// numeric amount column would be inexactness we chose, not inexactness we
// inherited — and money read back through a float misreports a declared figure.
// ---------------------------------------------------------------------------
test("every amount column is named *_cents and typed BIGINT", () => {
  const amountish =
    /(amount|cents|receipts|payments|debts|gift|expenditure|donations|discretionary)/;
  for (const t of TABLES) {
    for (const col of columns(t)) {
      if (!amountish.test(col.name)) continue;
      // Counters are integers of a different unit; they are not amounts.
      if (/_count$/.test(col.name)) continue;
      assert.match(
        col.name,
        /_cents$/,
        `${t}.${col.name} carries money but is not named *_cents`,
      );
      assert.equal(
        col.type,
        "BIGINT",
        `${t}.${col.name} must be BIGINT integer cents, got ${col.type}`,
      );
    }
  }
});

test("no aec_ table declares a float, double, real, money or numeric column", () => {
  for (const t of TABLES) {
    for (const col of columns(t)) {
      assert.doesNotMatch(
        col.type,
        /^(FLOAT|DOUBLE|REAL|MONEY|NUMERIC|DECIMAL)/,
        `${t}.${col.name} uses inexact type ${col.type}`,
      );
    }
  }
  // Belt and braces across the whole migration, including the MV projections.
  assert.doesNotMatch(
    upCode,
    /\b(DOUBLE PRECISION|MONEY|REAL)\b/i,
    "000105 introduces an inexact money type",
  );
});

// ---------------------------------------------------------------------------
// Licensing is an obligation, not a caption. AEC material is CC BY 4.0 and
// every row must be able to state where it came from and when it was taken.
// ---------------------------------------------------------------------------
test("every aec_ fact table carries source_url, source_licence and snapshot_at", () => {
  for (const t of TABLES) {
    if (t === "aec_entity_aliases") continue; // curated rows are ours, not the AEC's
    const body = tableBody(t);
    assert.match(body, /\bsource_url\s+TEXT NOT NULL/, `${t} lacks source_url`);
    assert.match(
      body,
      /\bsource_licence\s+TEXT NOT NULL DEFAULT 'CC-BY-4\.0'/,
      `${t} lacks a CC-BY-4.0 source_licence default`,
    );
    assert.match(body, /\bsnapshot_at\s+TIMESTAMPTZ NOT NULL/, `${t} lacks snapshot_at`);
  }
});

test("the curated alias table records who decided and when", () => {
  const body = tableBody("aec_entity_aliases");
  assert.match(body, /\bcurated_by\s+TEXT NOT NULL/);
  assert.match(body, /\bcurated_at\s+TIMESTAMPTZ NOT NULL/);
});

// ---------------------------------------------------------------------------
// The register subsystem is untouched. Its no-magnitude guard scans the
// register migrations; this migration must never widen that surface by
// referencing, altering or dropping anything the register owns.
// ---------------------------------------------------------------------------
test("no register_ table or view is referenced in either direction", () => {
  for (const [label, sql] of [["up", upCode], ["down", downCode]]) {
    assert.doesNotMatch(
      sql,
      /\bregister_[a-z_]+/,
      `000105 ${label} references a register_ object`,
    );
    assert.doesNotMatch(
      sql,
      /\bmv_register_[a-z_]+/,
      `000105 ${label} references a register materialized view`,
    );
    assert.doesNotMatch(
      sql,
      /refresh_register_materialized_views/,
      `000105 ${label} touches the register refresh function`,
    );
  }
});

test("nothing outside the aec_ namespace is altered or dropped", () => {
  const mutations = upCode.match(/\b(ALTER TABLE|DROP TABLE|DROP MATERIALIZED VIEW)\s+(\S+)/g) || [];
  for (const m of mutations) {
    assert.match(m, /\s(aec_|mv_aec_)/, `000105 mutates a non-aec object: ${m}`);
  }
  const drops = downCode.match(/DROP (?:TABLE|VIEW|MATERIALIZED VIEW|FUNCTION) IF EXISTS\s+([a-z_]+)/g) || [];
  assert.ok(drops.length > 0, "the down migration drops nothing");
  for (const d of drops) {
    assert.match(
      d,
      /\s(aec_|v_aec_|mv_aec_|refresh_aec_)/,
      `the down migration drops a non-aec object: ${d}`,
    );
  }
});

// The register's own read path joins politicians; this migration may reference
// politicians (that is the whole point of the member layer) but only as a
// nullable FK that degrades to a verbatim name.
test("politician joins are nullable and degrade rather than delete", () => {
  for (const t of ["aec_mp_returns", "aec_candidate_returns"]) {
    assert.match(
      tableBody(t),
      /politician_id\s+UUID REFERENCES politicians\(id\) ON DELETE SET NULL/,
      `${t}.politician_id must be a nullable SET NULL FK`,
    );
    assert.doesNotMatch(
      tableBody(t),
      /politician_id\s+UUID NOT NULL/,
      `${t} makes the politician join mandatory, which forces a guess`,
    );
  }
});

// ---------------------------------------------------------------------------
// Withholding is structural, not a convention someone remembers.
// ---------------------------------------------------------------------------
test("a resolution method cannot exist without its join, or a join without a method", () => {
  for (const t of ["aec_mp_returns", "aec_candidate_returns"]) {
    assert.match(
      tableBody(t),
      /CHECK \(\(politician_id IS NULL\) = \(resolution_method = 'unresolved'\)\)/,
      `${t} allows a join and its provenance to disagree`,
    );
  }
});

test("no resolution method admits a fuzzy or approximate match", () => {
  // Strip string literals as well as comments: the migration is allowed to SAY
  // "no fuzzy matching, ever" in a COMMENT ON, it is not allowed to DO it.
  const executable = upCode.replace(/'(?:[^']|'')*'/g, "''");
  assert.doesNotMatch(
    executable,
    /\b(levenshtein|similarity|word_similarity|soundex|metaphone|difference)\s*\(/i,
    "000105 calls an approximate-matching function",
  );
  assert.doesNotMatch(executable, /%>|<%|<->/, "000105 uses a similarity operator");
  assert.doesNotMatch(executable, /\bILIKE\b|\bLIKE\b/i, "000105 matches names by pattern");
});

// ---------------------------------------------------------------------------
// The company match layer: exact normalised name, ambiguity excluded entirely.
// ---------------------------------------------------------------------------
test("the company match view excludes normalised names colliding across codes", () => {
  const start = upCode.indexOf("CREATE OR REPLACE VIEW v_aec_company_name_matches");
  assert.notEqual(start, -1, "v_aec_company_name_matches not found");
  const body = upCode.slice(start, upCode.indexOf("COMMENT ON VIEW v_aec_company_name_matches"));
  assert.match(
    body,
    /HAVING count\(DISTINCT stock_code\) = 1/,
    "the view must keep only names resolving to exactly one stock code",
  );
  assert.match(body, /aec_entity_aliases/, "the view must consult curated aliases");
  assert.match(
    body,
    /a\.target_kind = 'company'[\s\S]*UNION ALL/,
    "curated aliases must be selected before the automatic layer",
  );
  assert.match(
    body,
    /a\.target_kind IN \('company', 'ignore'\)/,
    "an 'ignore' alias must suppress the automatic exact match",
  );
});

test("the alias table cannot hold a target-less curated decision", () => {
  const body = tableBody("aec_entity_aliases");
  assert.match(body, /target_kind <> 'company' OR stock_code IS NOT NULL/);
  assert.match(body, /target_kind <> 'politician' OR politician_id IS NOT NULL/);
  assert.match(body, /target_kind <> 'party_group' OR party_group <> ''/);
});

// Two key formats share alias_norm: the normalised entity name and the election
// files' 'SURNAME|GIVEN NAMES'. Without a discriminator a curator could file a
// key in the format the layer they meant will never read, and nothing would say
// so — the entry would simply never match.
test("the alias table discriminates its two key spaces structurally", () => {
  const body = tableBody("aec_entity_aliases");
  assert.match(body, /\btarget_layer\s+TEXT NOT NULL/, "aec_entity_aliases lacks a layer discriminator");
  assert.match(body, /target_layer IN \('entity_name', 'candidate_name'\)/);
  assert.match(
    body,
    /target_layer <> 'candidate_name' OR strpos\(alias_norm, '\|'\) > 0/,
    "a candidate-layer key must be in the SURNAME|GIVEN NAMES format",
  );
  assert.match(
    body,
    /target_layer <> 'entity_name' OR strpos\(alias_norm, '\|'\) = 0/,
    "an entity-layer key must not be in the candidate format",
  );
  // And the contract must be WRITTEN DOWN where a curator will find it.
  assert.match(
    up,
    /SURNAME\|GIVEN NAMES/,
    "the candidate alias key format is undocumented in the migration",
  );
});

test("the company match layer reads only entity-layer aliases", () => {
  const start = upCode.indexOf("CREATE OR REPLACE VIEW v_aec_company_name_matches");
  const body = upCode.slice(start, upCode.indexOf("COMMENT ON VIEW v_aec_company_name_matches"));
  const layerFilters = body.match(/target_layer = 'entity_name'/g) || [];
  assert.equal(
    layerFilters.length,
    2,
    "both the curated arm and the suppression check must name the key space they read",
  );
});

// ---------------------------------------------------------------------------
// Duplicate source rows are real; the natural keys must accommodate them.
// ---------------------------------------------------------------------------
test("occurrence counters are part of the natural key wherever duplicates are legitimate", () => {
  for (const t of [
    "aec_party_returns",
    "aec_receipts",
    "aec_donations_made",
    "aec_candidate_donations",
  ]) {
    const body = tableBody(t);
    assert.match(body, /\boccurrence\s+INTEGER NOT NULL/, `${t} lacks an occurrence counter`);
    assert.match(
      body,
      /UNIQUE \([^)]*occurrence\)/,
      `${t} does not include occurrence in its natural key, so real duplicates collide`,
    );
  }
});

// ---------------------------------------------------------------------------
// Verbatim AND normalised names. APH is ND; the AEC is not, but the same
// discipline applies: the source string is never rewritten in place.
// ---------------------------------------------------------------------------
test("name columns keep a verbatim value beside every normalised one", () => {
  const pairs = [
    ["aec_receipts", "recipient_name"],
    ["aec_receipts", "received_from"],
    ["aec_donations_made", "donor_name"],
    ["aec_donations_made", "made_to"],
    ["aec_candidate_donations", "donor_name"],
    ["aec_party_returns", "party_name"],
  ];
  for (const [t, col] of pairs) {
    const body = tableBody(t);
    assert.match(body, new RegExp(`\\b${col}\\s+TEXT NOT NULL`), `${t}.${col} missing`);
    assert.match(
      body,
      new RegExp(`\\b${col}_norm\\s+TEXT NOT NULL`),
      `${t}.${col}_norm missing — the normalised form must sit beside the verbatim one, never replace it`,
    );
  }
});

// ---------------------------------------------------------------------------
// Right-censoring and the 2027 regime break travel with the rollup.
// ---------------------------------------------------------------------------
test("the party funding rollup carries the censoring and reform-break flags", () => {
  assert.match(upCode, /AS threshold_censored/);
  assert.match(upCode, /financial_year_end >= 2027\)\s*AS post_reform_scheme/);
});

test("the rollup has a unique index so it can refresh concurrently", () => {
  assert.match(
    upCode,
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_aec_party_funding_key\s+ON mv_aec_party_funding \(party_group_key, financial_year\)/,
  );
});

test("the refresh function is aec-scoped and clears the statement timeout", () => {
  assert.match(upCode, /CREATE OR REPLACE FUNCTION refresh_aec_donations_materialized_views\(\)/);
  assert.match(
    upCode,
    /ALTER FUNCTION refresh_aec_donations_materialized_views\(\) SET statement_timeout TO '0'/,
  );
});

// ---------------------------------------------------------------------------
// A failed refresh must be LOUD. Swallowed into a WARNING it let the ingest log
// success while the rollup still described the snapshot the load had truncated,
// and as_at — read from the freshly written base tables — captioned those stale
// figures with the new timestamp.
// ---------------------------------------------------------------------------
test("the refresh reports its outcome instead of swallowing failure", () => {
  const start = upCode.indexOf("CREATE OR REPLACE FUNCTION refresh_aec_donations_materialized_views");
  assert.notEqual(start, -1);
  const body = upCode.slice(start, upCode.indexOf("ALTER FUNCTION refresh_aec_donations"));
  assert.match(body, /RETURNS BOOLEAN/i, "the refresh function returns nothing a caller can check");
  // Exactly one handler: the concurrent attempt may fall back, and a failure of
  // the fallback must propagate.
  const handlers = body.match(/EXCEPTION WHEN/g) || [];
  assert.equal(
    handlers.length,
    1,
    "a second exception handler would swallow the failure of the non-concurrent fallback",
  );
  assert.match(body, /INSERT INTO aec_refresh_log/, "a successful refresh is not recorded");
  assert.doesNotMatch(
    body,
    /RAISE WARNING 'Skipping/,
    "the refresh still degrades a failure to a warning",
  );
});

test("the refresh log records what the rollup was rebuilt from", () => {
  const body = tableBody("aec_refresh_log");
  assert.match(body, /\bsucceeded\s+BOOLEAN NOT NULL/);
  assert.match(
    body,
    /\bcorpus_snapshot_at\s+TIMESTAMPTZ/,
    "without the corpus snapshot there is no honest clock for an MV-backed figure",
  );
});

// ---------------------------------------------------------------------------
// The branch → group map is a property of a RETURN, not of a name for all time.
// ---------------------------------------------------------------------------
test("the party group map is keyed per financial year, and every consumer joins on it", () => {
  const start = upCode.indexOf("CREATE OR REPLACE VIEW v_aec_party_group_names");
  assert.notEqual(start, -1, "v_aec_party_group_names not found");
  const view = upCode.slice(start, upCode.indexOf("CREATE MATERIALIZED VIEW mv_aec_party_funding"));
  assert.match(
    view,
    /SELECT DISTINCT ON \(financial_year, party_name_norm\)/,
    "one group per branch name for all years misrolls historical receipts under a later label",
  );
  assert.match(view, /\bfinancial_year\b/, "the view must expose the year it applies to");

  // Both rollup arms must join on the year, or the fix stops at the view.
  const mv = upCode.slice(upCode.indexOf("CREATE MATERIALIZED VIEW mv_aec_party_funding"));
  const joins = mv.match(/JOIN v_aec_party_group_names g\s+ON g\.name_norm = \w+\.\w+\s+AND g\.financial_year = \w+\.financial_year/g) || [];
  assert.equal(joins.length, 2, "a rollup arm joins the party group map without the financial year");
});

// ---------------------------------------------------------------------------
// Losing a politician must DEGRADE a return, not fail. The SET NULL FK and the
// resolution CHECK contradict each other without this.
// ---------------------------------------------------------------------------
test("unlinking a politician resets the resolution method in the same statement", () => {
  assert.match(upCode, /CREATE OR REPLACE FUNCTION aec_reset_resolution_on_unlink\(\)/);
  for (const t of ["aec_mp_returns", "aec_candidate_returns"]) {
    assert.match(
      upCode,
      new RegExp(
        `BEFORE UPDATE OF politician_id ON ${t}\\s+FOR EACH ROW EXECUTE FUNCTION aec_reset_resolution_on_unlink\\(\\)`,
      ),
      `${t} has no trigger to degrade a row when its politician goes away`,
    );
  }
  // The CHECK stays: a method without its join is exactly the incoherence worth
  // forbidding, and the trigger is what makes it satisfiable.
  assert.match(
    tableBody("aec_mp_returns"),
    /CHECK \(\(politician_id IS NULL\) = \(resolution_method = 'unresolved'\)\)/,
  );
});

// ---------------------------------------------------------------------------
// The candidate rule's guards are the fix for a real misattribution, so their
// predicates must exist and must be exact-only.
// ---------------------------------------------------------------------------
test("the resolution predicates match exactly and only ever withhold", () => {
  assert.match(upCode, /CREATE OR REPLACE FUNCTION aec_given_names_agree\(a TEXT, b TEXT\)/);
  assert.match(upCode, /CREATE OR REPLACE FUNCTION aec_party_contradicts\(a TEXT, b TEXT\)/);
  const start = upCode.indexOf("CREATE OR REPLACE FUNCTION aec_given_names_agree");
  const given = upCode.slice(start, upCode.indexOf("CREATE OR REPLACE FUNCTION aec_party_family"));
  // Token equality only: no prefix, substring or distance rule may creep in.
  assert.doesNotMatch(given, /\bsubstr|left\s*\(|starts_with|position\s*\(/i,
    "given-name agreement must be exact token equality, never a prefix rule");
  assert.match(given, /at\[1\] = bt\[1\]/, "the first given names must be compared exactly");
});

// ---------------------------------------------------------------------------
// Rule 6 of the plan: no causal or influence vocabulary, anywhere, including
// comments and column names.
// ---------------------------------------------------------------------------
test("no influence or causal vocabulary appears in the migration", () => {
  const banned =
    /\b(bribe[ds]?|bought influence|buying influence|cash for|corrupt(?:ed|ion)?|rort(?:ed)?|kickback|rigged)\b/i;
  assert.doesNotMatch(up, banned, "000105 uses banned influence vocabulary");
  assert.doesNotMatch(down, banned, "the down migration uses banned influence vocabulary");
});
