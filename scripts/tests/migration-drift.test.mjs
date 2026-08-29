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

test("the ledger declares a parseable baseline", () => {
  const match = ledger.match(/^BASELINE:\s*(\d{6})$/m);
  assert.ok(
    match,
    "PROD_APPLIED.md must contain a line like `BASELINE: 000115`. Without it " +
      "this guard cannot tell which migrations it is responsible for.",
  );
  assert.ok(Number.isFinite(Number.parseInt(match[1], 10)));
});

test("every migration after the baseline is allowlisted or recorded as hand-applied", () => {
  const baseline = Number.parseInt(ledger.match(/^BASELINE:\s*(\d{6})$/m)[1], 10);

  const unaccounted = upMigrations.filter((file) => {
    if (versionOf(file) <= baseline) return false;
    const allowlisted = workflow.includes(`/migrations/${file}`);
    const handApplied = ledger.includes(file.replace(/\.up\.sql$/, ""));
    return !allowlisted && !handApplied;
  });

  assert.deepEqual(
    unaccounted,
    [],
    `These migrations exist but would never reach prod:\n\n` +
      unaccounted.map((f) => `  - ${f}`).join("\n") +
      `\n\nProd does not run \`migrate up\`. Do ONE of:\n\n` +
      `  1. Hand-apply it (session pooler 5432, statement_timeout=0 — \n` +
      `     \`task db:prod:apply FILE=… CONFIRM=prod\`) and add a row to\n` +
      `     services/migrations/PROD_APPLIED.md saying how you verified it.\n\n` +
      `  2. Add it to the allowlist in .github/workflows/terraform-deploy.yml —\n` +
      `     but ONLY if it is replay-safe. The allowlist re-runs on EVERY deploy:\n` +
      `     every statement must be IF NOT EXISTS / CREATE OR REPLACE, with no\n` +
      `     bare ADD COLUMN, no INSERT without ON CONFLICT, and no DROP+CREATE of\n` +
      `     a materialized view (that would rebuild it on every deploy).\n` +
      `     000112_add_api_usage_monthly is the worked example.\n`,
  );
});

test("allowlisted migrations are replay-safe, because the deploy re-runs them", () => {
  // The allowlist is not a list of "migrations we want"; it is a list of
  // statements prod executes on every single deploy. A DROP+CREATE of a
  // materialized view here is an outage window per deploy, and an unguarded
  // INSERT duplicates rows forever.
  const allowlisted = upMigrations.filter((f) => workflow.includes(`/migrations/${f}`));
  assert.ok(allowlisted.length > 0, "expected the deploy to allowlist at least one migration");

  // No exceptions. There was one — 000083, which this check flagged on its first
  // run — and rather than carry it, the migration was removed from the allowlist
  // (it was already applied to prod, so replaying it could only undo work). An
  // exception list is where a guard goes to die, so it stays empty until
  // something genuinely cannot be fixed.

  const offenders = [];
  for (const file of allowlisted) {
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
