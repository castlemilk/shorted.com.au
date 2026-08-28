import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const up = readFileSync(
  new URL("./000116_add_oauth_clients.up.sql", import.meta.url),
  "utf8",
);

const down = readFileSync(
  new URL("./000116_add_oauth_clients.down.sql", import.meta.url),
  "utf8",
);

const workflow = readFileSync(
  new URL("../../.github/workflows/terraform-deploy.yml", import.meta.url),
  "utf8",
);

// The file is heavily commented, and the comments name the very keywords the
// idempotency scan looks for ("no ALTER, no INSERT, no DROP"). Scan executable
// SQL only, or the prose fails the test it is describing.
const stripComments = (sql) =>
  sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");

const upSQL = stripComments(up);

const TABLES = [
  "oauth_clients",
  "oauth_authorization_codes",
  "oauth_refresh_tokens",
];

const INDEXES = [
  "idx_oauth_refresh_tokens_family",
  "idx_oauth_authorization_codes_expires",
  "idx_oauth_authorization_codes_client",
  "idx_oauth_refresh_tokens_client",
];

test("all three tables exist and are created idempotently", () => {
  for (const table of TABLES) {
    assert.match(
      up,
      new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, "i"),
      `${table} must be created with IF NOT EXISTS`,
    );
  }
});

// Prod does not run `migrate up`. The deploy replays a hardcoded allowlist on
// EVERY deploy, so a non-idempotent statement here would corrupt live grants
// several times a week.
test("every statement is idempotent, because prod replays this file on every deploy", () => {
  assert.match(upSQL, /CREATE TABLE IF NOT EXISTS/i);
  assert.match(upSQL, /CREATE INDEX IF NOT EXISTS/i);

  // Any CREATE that is not IF NOT EXISTS would fail on replay.
  const creates = upSQL.match(/^\s*CREATE\s+[A-Z ]*?(TABLE|INDEX)\b.*$/gim) ?? [];
  assert.ok(creates.length > 0);
  for (const stmt of creates) {
    assert.match(
      stmt,
      /IF NOT EXISTS/i,
      `not replayable: ${stmt.trim()}`,
    );
  }

  const destructive = /\b(DROP|TRUNCATE|DELETE FROM|ALTER TABLE)\b/i;
  assert.ok(
    !destructive.test(upSQL),
    "a replayed migration must not drop, truncate, delete or alter anything",
  );

  assert.ok(
    !/\bINSERT INTO\b/i.test(upSQL),
    "seeding rows here would re-seed them on every deploy",
  );
});

// The whole point of the schema: a database dump must not hand an attacker a
// usable credential. Every column whose name suggests bearer material must be
// a hash (or a display prefix), never the value itself.
test("no column stores a raw secret", () => {
  // A column definition is the first token of a line inside a CREATE TABLE
  // body. Comments are already stripped, so prose cannot masquerade as one.
  const columns = upSQL
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[a-z_]+\s+(TEXT|UUID|TIMESTAMPTZ|BIGINT|BOOLEAN|VARCHAR)/i.test(line))
    .map((line) => line.split(/\s+/)[0]);

  assert.ok(columns.length > 10, "column scan found nothing — regex drifted");

  // Public-by-construction values that merely contain a suspicious word.
  const NOT_SECRETS = new Set([
    "code_hash",
    "code_challenge", // an S256 digest of the verifier; the verifier is never stored
    "code_challenge_method",
    "token_hash",
    "client_secret_hash",
    "grant_types",
  ]);

  const suspicious = /(^|_)(code|token|secret|verifier|password|key)(_|$)/i;
  for (const column of columns) {
    if (NOT_SECRETS.has(column)) continue;
    assert.ok(
      !suspicious.test(column),
      `${column} looks like it stores bearer material; store sha256(value) as *_hash instead`,
    );
  }

  // And the ones we do keep must be hashes, spelled as such.
  for (const hashed of ["code_hash", "token_hash", "client_secret_hash"]) {
    assert.ok(
      columns.includes(hashed),
      `${hashed} must exist — the raw value is never stored`,
    );
  }
});

test("an authorization code can be consumed exactly once", () => {
  // A nullable consumed_at is what makes the redemption a single conditional
  // UPDATE. A NOT NULL DEFAULT or a boolean with a default would both make
  // "not yet consumed" indistinguishable from "consumed at the epoch".
  assert.match(up, /consumed_at TIMESTAMPTZ\s*,/i);
  assert.ok(
    !/consumed_at[^,]*NOT NULL/i.test(up),
    "consumed_at must be nullable so WHERE consumed_at IS NULL is the guard",
  );
  assert.match(up, /expires_at TIMESTAMPTZ NOT NULL/i);
  assert.match(up, /code_hash TEXT PRIMARY KEY/i);
});

test("PKCE is S256-only at the schema level, so a downgrade is unstorable", () => {
  assert.match(up, /CHECK \(code_challenge_method = 'S256'\)/i);
});

test("refresh tokens carry a family and both rotation and revocation marks", () => {
  assert.match(up, /family_id UUID NOT NULL/i);
  assert.match(up, /rotated_at TIMESTAMPTZ/i);
  assert.match(up, /revoked_at TIMESTAMPTZ/i);
});

test("registration_source is constrained to the two paths that exist", () => {
  assert.match(up, /CHECK \(registration_source IN \('dcr', 'cimd'\)\)/i);
});

test("indexes cover family revocation, code sweeping and the cascades", () => {
  assert.match(
    up,
    /CREATE INDEX IF NOT EXISTS idx_oauth_refresh_tokens_family\s+ON oauth_refresh_tokens \(family_id\)/i,
  );
  assert.match(
    up,
    /CREATE INDEX IF NOT EXISTS idx_oauth_authorization_codes_expires\s+ON oauth_authorization_codes \(expires_at\)/i,
  );
});

test("redirect_uris is a set, matched by exact equality rather than a pattern", () => {
  assert.match(up, /redirect_uris TEXT\[\] NOT NULL DEFAULT '\{\}'/i);
  assert.match(
    up,
    /never by prefix|never a\s*\n?--\s*prefix|EXACT STRING EQUALITY/i,
    "the exact-match rule must be stated where the column is defined",
  );
});

test("the down migration drops everything the up migration creates", () => {
  for (const table of TABLES) {
    assert.match(down, new RegExp(`DROP TABLE IF EXISTS ${table}\\b`, "i"));
  }
  for (const index of INDEXES) {
    assert.match(down, new RegExp(`DROP INDEX IF EXISTS ${index}\\b`, "i"));
  }

  // Children before parents, or the foreign keys block the drop.
  assert.ok(
    down.indexOf("DROP TABLE IF EXISTS oauth_refresh_tokens") <
      down.indexOf("DROP TABLE IF EXISTS oauth_clients"),
  );
  assert.ok(
    down.indexOf("DROP TABLE IF EXISTS oauth_authorization_codes") <
      down.indexOf("DROP TABLE IF EXISTS oauth_clients"),
  );
});

test("the migration is in the prod deploy allowlist, or it never reaches prod", () => {
  assert.match(workflow, /-f \/migrations\/000116_add_oauth_clients\.up\.sql/);
});

test("000116 stays before 000095 so the hardened MV refresh definition still wins", () => {
  const idx116 = workflow.indexOf("000116_add_oauth_clients.up.sql");
  const idx095 = workflow.indexOf("000095_harden_mv_refresh.up.sql");
  assert.ok(idx116 > 0 && idx095 > 0);
  assert.ok(
    idx116 < idx095,
    "000095 must remain the last file applied — see the ORDER IS LOAD-BEARING note",
  );
});

test("000116 does not touch refresh_all_materialized_views", () => {
  // The only reason a migration would need to sit AFTER 000095.
  assert.ok(!/refresh_all_materialized_views/i.test(up));
});
