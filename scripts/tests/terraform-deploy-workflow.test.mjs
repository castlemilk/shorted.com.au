import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

const workflowPath = new URL("../../.github/workflows/terraform-deploy.yml", import.meta.url);
const workflowSource = readFileSync(workflowPath, "utf8");
const workflow = parse(workflowSource);

function step(jobName, stepName) {
  const job = workflow.jobs?.[jobName];
  assert.ok(job, `missing workflow job ${jobName}`);
  const match = job.steps?.find((candidate) => candidate.name === stepName);
  assert.ok(match, `missing workflow step ${jobName} / ${stepName}`);
  return match;
}

function lines(script) {
  return script
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

test("production database migration step avoids golang-migrate and repairs schema state directly", () => {
  const run = step("terraform-apply", "Run database migrations").run;
  assert.equal(typeof run, "string");

  const prodBlock = run.slice(
    run.indexOf('if [ "$ENVIRONMENT" = "prod" ]; then'),
    run.indexOf("exit 0"),
  );
  assert.ok(prodBlock.length > 0, "expected explicit prod migration block");

  assert.match(prodBlock, /psql "\$DB_URL_CLEAN"/);
  assert.match(prodBlock, /000070_add_short_campaigns_mv\.up\.sql/);
  assert.match(prodBlock, /000071_add_corporate_tax\.up\.sql/);
  assert.match(prodBlock, /CREATE TABLE IF NOT EXISTS schema_migrations/);
  assert.match(prodBlock, /DELETE FROM schema_migrations/);
  assert.match(prodBlock, /VALUES \(71, false\)/);
  assert.doesNotMatch(prodBlock, /migrate\/migrate/);
});

test("production tax bootstrap only runs when corporate_tax is empty and ignores local go.work", () => {
  const run = step("terraform-apply", "Run database migrations").run;

  assert.match(run, /SELECT COUNT\(\*\) FROM corporate_tax/);
  assert.match(run, /if \[ "\$\{TAX_ROWS:-0\}" = "0" \]; then/);
  assert.match(run, /go run \.\/influence-collector -mode all/);
  assert.match(run, /GOWORK=off/);
  assert.match(run, /GOPRIVATE=github\.com\/skunkworq\/\*/);
  assert.match(run, /GONOSUMDB=github\.com\/skunkworq\/\*/);
  assert.match(run, /corporate_tax already has \$\{TAX_ROWS\} rows; skipping bootstrap/);
});

test("non-production environments still run the normal ordered migration chain", () => {
  const run = step("terraform-apply", "Run database migrations").run;
  const scriptLines = lines(run);
  const migrationImageLine = scriptLines.findIndex((line) => line === "migrate/migrate:v4.16.2 \\");
  assert.notEqual(migrationImageLine, -1, "expected non-prod migrate image");

  const prodExit = scriptLines.findIndex((line) => line === "exit 0");
  assert.ok(prodExit > -1, "expected prod block to exit before non-prod migrate");
  assert.ok(migrationImageLine > prodExit, "migrate should only be used after the prod block exits");
  assert.match(run, /-path=\/migrations/);
  assert.match(run, /-database "\$DB_URL_CLEAN"/);
  assert.match(run, /\s+up\s*$/);
});

test("ko setup is pinned so deploy does not depend on GitHub latest-release lookup", () => {
  const setupKo = step("build-ko-images", "Setup ko");

  assert.equal(setupKo.uses, "ko-build/setup-ko@v0.9");
  assert.equal(setupKo.with?.version, "v0.19.1");
});
