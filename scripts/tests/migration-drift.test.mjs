import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

/**
 * Prod does not run `migrate up`. The deploy applies a hardcoded allowlist and
 * then force-writes schema_migrations to 75, so the database cannot report what
 * it actually has — it reports 75 forever. A migration that is neither
 * allowlisted nor hand-applied simply never reaches prod, and the first symptom
 * is a read path selecting a column that isn't there.
 *
 * That has bitten repeatedly (see the housing landmine in CLAUDE.md). This turns
 * it from a silent operational dependency into a failing check.
 *
 * Scope is deliberately forward-only. 114 migrations predate the ledger and
 * their status was never recorded; demanding a retro-audit would get this guard
 * deleted rather than satisfied. So it enforces only migrations above the
 * recorded BASELINE, which stops drift accumulating from here.
 *
 * A migration is accounted for by the deploy allowlist or by a ROW of one of
 * the ledger's two tables, never by a mention elsewhere in it:
 *   - "Applied by hand": on prod, with a Verified cell saying how that is known.
 *   - "Written, not yet applied": merged before an operator ran it. Allowed, so
 *     code that tolerates the missing DDL can ship first, but it is NOT
 *     applied: every run names these migrations, and they stay pending until
 *     the row moves up. The guard used to accept any migration whose name
 *     appeared anywhere in the ledger, which could not tell the two apart.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const migrationsDir = path.join(repoRoot, "services/migrations");
const ledgerPath = path.join(migrationsDir, "PROD_APPLIED.md");
const workflowPath = path.join(repoRoot, ".github/workflows/terraform-deploy.yml");

const ledger = readFileSync(ledgerPath, "utf8");
const workflow = readFileSync(workflowPath, "utf8");

const upMigrations = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".up.sql"))
  .sort();

const versionOf = (file) => Number.parseInt(file.slice(0, 6), 10);
const nameOf = (file) => file.replace(/\.up\.sql$/, "");
const allowlisted = (file) => workflow.includes(`/migrations/${file}`);

const APPLIED = "Applied by hand";
const PENDING = "Written, not yet applied";

// GitHub-flavoured table cells: split on pipes that are not escaped.
const cellsOf = (line) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());
const isSeparator = (line) => /^\|(\s*:?-{3,}:?\s*\|)+\s*$/.test(line.trim());

/**
 * Every table in the ledger, by the `## ` section it sits in. A row names a
 * migration only when its first cell is exactly one backticked
 * `NNNNNN_name`; `migration` is null otherwise.
 */
function ledgerTables(markdown) {
  const tables = {};
  const lines = markdown.split("\n");
  let section = null;
  let i = 0;
  while (i < lines.length) {
    const heading = lines[i].match(/^##\s+(.+?)\s*$/);
    if (heading) {
      section = heading[1];
      i += 1;
      continue;
    }
    if (!(section && lines[i].startsWith("|") && isSeparator(lines[i + 1] ?? ""))) {
      i += 1;
      continue;
    }
    const header = cellsOf(lines[i]);
    const rows = (tables[section] ??= []);
    for (i += 2; i < lines.length && lines[i].startsWith("|"); i += 1) {
      const values = cellsOf(lines[i]);
      rows.push({
        migration: values[0].match(/^`(\d{6}_[a-z0-9_]+)`$/)?.[1] ?? null,
        first: values[0],
        width: values.length,
        headerWidth: header.length,
        cells: Object.fromEntries(header.map((column, k) => [column, values[k] ?? ""])),
      });
    }
  }
  return tables;
}

const cellStartingWith = (row, prefix) =>
  Object.entries(row.cells).find(([column]) => column.toLowerCase().startsWith(prefix.toLowerCase()))?.[1] ?? "";

const tables = ledgerTables(ledger);
const appliedRows = tables[APPLIED] ?? [];
const pendingRows = tables[PENDING] ?? [];

test("the ledger declares a parseable baseline", () => {
  const match = ledger.match(/^BASELINE:\s*(\d{6})$/m);
  assert.ok(
    match,
    "PROD_APPLIED.md must contain a line like `BASELINE: 000115`. Without it " +
      "this guard cannot tell which migrations it is responsible for.",
  );
  assert.ok(Number.isFinite(Number.parseInt(match[1], 10)));
});

test("only a row of the ledger's two tables accounts for a migration, never a mention", () => {
  const sample = [
    "## Applied by hand",
    "",
    "| Migration | Date | By | Verified |",
    "|---|---|---|---|",
    "| `000901_one` | 2026-10-22 | an operator | `SELECT 1` returned 1 |",
    "",
    "Prose naming `000902_two`, and 000903_three in passing.",
    "",
    "## Written, not yet applied",
    "",
    "| Migration | Before applying | Command | How to verify, then move the row up |",
    "|---|---|---|---|",
    "| `000904_four` | nothing | `task db:prod:apply FILE=services/migrations/000904_four.up.sql CONFIRM=prod` | `SELECT 1` |",
    "| see `000905_five` | nothing | | |",
  ].join("\n");
  const parsed = ledgerTables(sample);
  assert.deepEqual(parsed[APPLIED].map((row) => row.migration), ["000901_one"]);
  assert.deepEqual(parsed[PENDING].map((row) => row.migration), ["000904_four", null]);
  assert.equal(parsed[PENDING][0].cells.Command, "`task db:prod:apply FILE=services/migrations/000904_four.up.sql CONFIRM=prod`");
  assert.equal(cellStartingWith(parsed[PENDING][0], "How to verify"), "`SELECT 1`");
});

test("the ledger's tables are well formed: one real migration per row, in one table", () => {
  assert.ok(appliedRows.length > 0, `PROD_APPLIED.md must keep its "${APPLIED}" table`);
  const files = new Set(upMigrations.map(nameOf));
  const problems = [];
  const seen = new Map();
  for (const [section, rows] of [
    [APPLIED, appliedRows],
    [PENDING, pendingRows],
  ]) {
    for (const row of rows) {
      if (row.width !== row.headerWidth) {
        problems.push(`${section}: ${row.first}: ${row.width} cells where the header has ${row.headerWidth} (an unescaped | ?)`);
      }
      if (!row.migration) {
        problems.push(`${section}: the first cell ${JSON.stringify(row.first)} is not one \`NNNNNN_name\``);
        continue;
      }
      if (!files.has(row.migration)) problems.push(`${section}: ${row.migration} has no .up.sql file`);
      if (seen.has(row.migration)) {
        problems.push(`${row.migration} is listed under both "${seen.get(row.migration)}" and "${section}": move the row, do not copy it`);
      }
      seen.set(row.migration, section);
    }
  }
  for (const row of appliedRows) {
    if (row.migration && !cellStartingWith(row, "Verified").trim()) {
      problems.push(`${APPLIED}: ${row.migration} must say how it was verified, the query you ran, not "ran it"`);
    }
  }
  assert.deepEqual(problems, []);
});

test("every migration after the baseline is allowlisted, applied by hand, or listed as not yet applied", (t) => {
  const baseline = Number.parseInt(ledger.match(/^BASELINE:\s*(\d{6})$/m)[1], 10);
  const applied = new Set(appliedRows.map((row) => row.migration));
  const pending = new Set(pendingRows.map((row) => row.migration));

  const unaccounted = [];
  const waiting = [];
  for (const file of upMigrations) {
    if (versionOf(file) <= baseline || allowlisted(file) || applied.has(nameOf(file))) continue;
    if (pending.has(nameOf(file))) waiting.push(nameOf(file));
    else unaccounted.push(file);
  }

  // Accounted for, not applied. Printed on every run so the gap stays in view.
  if (waiting.length > 0) {
    t.diagnostic(
      `${waiting.length} hand-apply migration(s) are merged but NOT on prod until their row moves to "${APPLIED}": ` +
        waiting.join(", "),
    );
  }

  assert.deepEqual(
    unaccounted,
    [],
    `These migrations exist but would never reach prod:\n\n` +
      unaccounted.map((f) => `  - ${f}`).join("\n") +
      `\n\nProd does not run \`migrate up\`. Do ONE of:\n\n` +
      `  1. Hand-apply it (session pooler 5432, statement_timeout=0 — \n` +
      `     \`task db:prod:apply FILE=… CONFIRM=prod\`) and add a row to the\n` +
      `     "${APPLIED}" table in services/migrations/PROD_APPLIED.md saying how\n` +
      `     you verified it. A mention anywhere else in the file does not count.\n\n` +
      `  2. If it merges before an operator applies it (the code must work\n` +
      `     without it), add a row to the "${PENDING}" table with its\n` +
      `     command and how to verify it, and move the row up once it is applied.\n\n` +
      `  3. Add it to the allowlist in .github/workflows/terraform-deploy.yml —\n` +
      `     but ONLY if it is replay-safe. The allowlist re-runs on EVERY deploy:\n` +
      `     every statement must be IF NOT EXISTS / CREATE OR REPLACE, with no\n` +
      `     bare ADD COLUMN, no INSERT without ON CONFLICT, and no DROP+CREATE of\n` +
      `     a materialized view (that would rebuild it on every deploy).\n` +
      `     000112_add_api_usage_monthly is the worked example.\n`,
  );
});

test("a migration listed as not yet applied is a hand-apply with its command and a check", () => {
  const problems = [];
  for (const row of pendingRows) {
    if (!row.migration) continue; // reported by the well-formed test
    const file = `${row.migration}.up.sql`;
    if (allowlisted(file)) {
      problems.push(`${row.migration} is allowlisted, so the deploy applies it: it is not waiting for a hand-apply`);
    }
    const command = `task db:prod:apply FILE=services/migrations/${file} CONFIRM=prod`;
    if (!cellStartingWith(row, "Command").includes(command)) {
      problems.push(`${row.migration}: the Command cell must hold \`${command}\``);
    }
    if (!cellStartingWith(row, "How to verify").trim()) {
      problems.push(`${row.migration}: say how to verify it, so the row can move to "${APPLIED}"`);
    }
  }
  assert.deepEqual(problems, []);
});

test("allowlisted migrations are replay-safe, because the deploy re-runs them", () => {
  // The allowlist is not a list of "migrations we want"; it is a list of
  // statements prod executes on every single deploy. A DROP+CREATE of a
  // materialized view here is an outage window per deploy, and an unguarded
  // INSERT duplicates rows forever.
  const allowlistedFiles = upMigrations.filter(allowlisted);
  assert.ok(allowlistedFiles.length > 0, "expected the deploy to allowlist at least one migration");

  // No exceptions. There was one — 000083, which this check flagged on its first
  // run — and rather than carry it, the migration was removed from the allowlist
  // (it was already applied to prod, so replaying it could only undo work). An
  // exception list is where a guard goes to die, so it stays empty until
  // something genuinely cannot be fixed.

  const offenders = [];
  for (const file of allowlistedFiles) {
    const sql = readFileSync(path.join(migrationsDir, file), "utf8");
    const stripped = sql.replace(/--.*$/gm, "");
    if (/DROP\s+MATERIALIZED\s+VIEW/i.test(stripped)) {
      offenders.push(`${file}: drops a materialized view (rebuilt on every deploy)`);
    }
    if (/\bINSERT\s+INTO\b/i.test(stripped) && !/ON\s+CONFLICT/i.test(stripped)) {
      offenders.push(`${file}: INSERT without ON CONFLICT (duplicates rows on replay)`);
    }
    if (/ADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS)/i.test(stripped)) {
      offenders.push(`${file}: bare ADD COLUMN (fails on replay)`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `Allowlisted migrations must be replay-safe — the deploy runs them every time:\n\n` +
      offenders.map((o) => `  - ${o}`).join("\n"),
  );
});
