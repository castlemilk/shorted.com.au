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
  assert.match(prodBlock, /000074_add_alert_monitors\.up\.sql/);
  assert.match(prodBlock, /000075_add_industry_intelligence_sources\.up\.sql/);
  assert.match(prodBlock, /CREATE TABLE IF NOT EXISTS schema_migrations/);
  assert.match(prodBlock, /DELETE FROM schema_migrations/);
  assert.match(prodBlock, /VALUES \(75, false\)/);
  assert.doesNotMatch(prodBlock, /migrate\/migrate/);
});

test("production tax bootstrap imports all sources when empty and refreshes public records otherwise", () => {
  const run = step("terraform-apply", "Run database migrations").run;

  assert.match(run, /SELECT COUNT\(\*\) FROM corporate_tax/);
  assert.match(run, /if \[ "\$\{TAX_ROWS:-0\}" = "0" \]; then/);
  assert.match(run, /go run \.\/influence-collector -mode all/);
  assert.match(run, /corporate_tax already has \$\{TAX_ROWS\} rows; refreshing public industry intelligence records/);
  assert.match(run, /go run \.\/influence-collector -mode public-records/);
  assert.match(run, /GOWORK=off/);
  assert.match(run, /GOPRIVATE=github\.com\/skunkworq\/\*/);
  assert.match(run, /GONOSUMDB=github\.com\/skunkworq\/\*/);
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

// The deploy must not ship over a red test suite.
//
// `run-tests` used to run in PARALLEL with the deploy with nothing listing it in
// `needs`, so a failing suite blocked nothing — the backend applied, the frontend
// promoted, and CI went red afterwards. That is tolerable for advisory smoke and
// not tolerable for the register-of-interests suite, whose tests exist to stop a
// wrong company being published against a named MP.
//
// Two assertions, because either alone can be defeated: the `needs` edge, and the
// explicit result check that survives someone adding always()/!cancelled().
test("terraform-apply is gated on run-tests", () => {
  const apply = workflow.jobs?.["terraform-apply"];
  assert.ok(apply, "missing terraform-apply job");
  assert.ok(
    (apply.needs ?? []).includes("run-tests"),
    "terraform-apply must list run-tests in needs, or a red suite deploys anyway",
  );
  assert.match(
    String(apply.if ?? "").replace(/\s+/g, " "),
    /needs\.run-tests\.result == 'success'/,
    "terraform-apply must assert needs.run-tests.result explicitly, so the gate survives always()",
  );
});

// The frontend promote inherits the gate through terraform-apply. If that edge is
// ever cut, the promote must not become reachable over red tests.
test("the vercel promote inherits the test gate", () => {
  const vercel = workflow.jobs?.["deploy-vercel-prod"];
  assert.ok(vercel, "missing deploy-vercel-prod job");
  const needs = vercel.needs ?? [];
  assert.ok(
    needs.includes("terraform-apply") || needs.includes("run-tests"),
    "deploy-vercel-prod must depend on terraform-apply (which is gated) or on run-tests directly",
  );
});

// run-tests must actually run the jobs module. services/jobs is a SEPARATE Go
// module, invisible to `go list ./...` in services, so the register suite ran
// nowhere at all until this step existed.
test("run-tests runs the separate jobs module", () => {
  const s = step("run-tests", "Run jobs-module unit tests");
  assert.match(s.run, /cd services\/jobs/, "must cd into the jobs module");
  assert.match(s.run, /go test \.\/\.\.\./, "must run the whole module's tests");
});
