import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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

test("infrastructure CI cannot recreate or authenticate to the retired dev environment", () => {
  assert.doesNotMatch(workflowSource, /shorted-dev-aba5688f/);
  assert.doesNotMatch(workflowSource, /github-actions-sa@shorted-dev/);
  assert.equal(workflow.jobs?.["deploy-preview"], undefined);
  assert.equal(workflow.jobs?.["cleanup-preview"], undefined);

  const determine = step("determine-environment", "Determine environment").run;
  assert.match(determine, /environment=prod/);
  assert.match(determine, /project-id=rosy-clover-477102-t5/);
  assert.doesNotMatch(determine, /environment=dev/);

  const ensureSecrets = step(
    "terraform-plan",
    "Ensure secrets exist in Secret Manager",
  );
  assert.equal(ensureSecrets.if, "github.event_name != 'pull_request'");

  assert.equal(
    existsSync(new URL("../../terraform/environments/dev", import.meta.url)),
    false,
  );
  assert.equal(
    existsSync(new URL("../../terraform/modules/preview", import.meta.url)),
    false,
  );
});

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
  assert.doesNotMatch(
    prodBlock,
    /000113_retire_dev_bucket_urls/,
    "the reviewed data rewrite must not become an automatic deploy side effect",
  );
  assert.match(prodBlock, /CREATE TABLE IF NOT EXISTS schema_migrations/);
  assert.match(prodBlock, /DELETE FROM schema_migrations/);
  assert.match(prodBlock, /VALUES \(75, false\)/);
  assert.doesNotMatch(prodBlock, /migrate\/migrate/);
});

test("production tax bootstrap imports all sources when empty and refreshes public records otherwise", () => {
  const run = step("terraform-apply", "Run database migrations").run;

  assert.match(run, /SELECT COUNT\(\*\) FROM corporate_tax/);
  assert.match(run, /if \[ "\$\{TAX_ROWS:-0\}" = "0" \]; then/);

  // The two branches select the mode; the collector invocation is shared and
  // parameterised, so assert the dispatch rather than two literal commands.
  assert.match(run, /run_influence_ingest all\b/);
  assert.match(run, /corporate_tax already has \$\{TAX_ROWS\} rows; refreshing public industry intelligence records/);
  assert.match(run, /run_influence_ingest public-records\b/);
  assert.match(run, /go run \.\/influence-collector -mode '"\$mode"/);

  assert.match(run, /GOWORK=off/);
  assert.match(run, /GOPRIVATE=github\.com\/skunkworq\/\*/);
  assert.match(run, /GONOSUMDB=github\.com\/skunkworq\/\*/);
});

test("a third-party data ingest cannot fail the production deploy", () => {
  const run = step("terraform-apply", "Run database migrations").run;

  // This ingest reads data.gov.au. A CKAN timeout there used to exit 1 and take
  // the whole terraform-apply with it, so a busy government endpoint blocked a
  // Cloud Run release. The data has its own scheduled collector; a deploy that
  // ships with yesterday's records beats a deploy that cannot ship.
  assert.match(run, /if docker run --rm/, "the ingest must run inside an if-guard, not bare");
  assert.match(
    run,
    /::warning::influence-collector -mode \$mode failed/,
    "an ingest failure must surface as a warning",
  );
  assert.match(run, /GITHUB_STEP_SUMMARY/, "an ingest failure must be visible in the job summary");

  // The guard is only meaningful if the failure path does not then exit non-zero.
  const fn = run.slice(run.indexOf("run_influence_ingest() {"), run.indexOf("TAX_ROWS="));
  assert.ok(fn.length > 0, "expected the run_influence_ingest helper");
  assert.doesNotMatch(fn, /\bexit [1-9]/, "the ingest helper must not exit non-zero on failure");
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
