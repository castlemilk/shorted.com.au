import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse } from "yaml";

const workflowPath = new URL("../../.github/workflows/terraform-deploy.yml", import.meta.url);
const workflowSource = readFileSync(workflowPath, "utf8");
const workflow = parse(workflowSource);

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/** Files git tracks under a path — [] when the retired environment is gone. */
function trackedUnder(path) {
  const out = execFileSync("git", ["ls-files", "--", path], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return out.split("\n").filter(Boolean);
}

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

test("Terraform jobs install the Cloud SDK before their first gcloud consumer", () => {
  for (const jobName of ["terraform-plan", "terraform-apply"]) {
    const steps = workflow.jobs[jobName].steps;
    const authIndex = steps.findIndex((candidate) => candidate.uses === "google-github-actions/auth@v3");
    const sdkIndex = steps.findIndex((candidate) => candidate.uses === "google-github-actions/setup-gcloud@v3");
    const consumerIndex = steps.findIndex((candidate) =>
      /\bgcloud\b|scripts\/ensure-secret\.sh/.test(candidate.run ?? ""),
    );
    assert.ok(authIndex >= 0, `${jobName} must authenticate with the existing action`);
    assert.ok(sdkIndex > authIndex, `${jobName} must install the SDK after authentication`);
    assert.ok(consumerIndex > sdkIndex, `${jobName} must install gcloud before using it`);
    assert.equal(steps[sdkIndex].if, undefined, `${jobName} must install the SDK on every execution`);
  }
});

function runRevisionAssertion(tag, rows) {
  const assertion = step("terraform-apply", "Assert running revisions match this commit");
  return spawnSync("bash", ["-c", `gcloud() { printf '%s\\n' "$MOCK_SERVICE_ROWS"; }
${assertion.run}`], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      GCP_PROJECT_ID: "fixture-project",
      GCP_REGION: "australia-southeast2",
      EXPECTED_TAG: tag,
      GITHUB_REF_NAME: "main",
      GITHUB_SHA: "f55838bdd09738d8f441baed178ba814feaa89a9",
      MOCK_SERVICE_ROWS: rows,
    },
  });
}

test("running revision assertion uses the canonical build and Terraform image tag", () => {
  const assertion = step("terraform-apply", "Assert running revisions match this commit");
  assert.equal(assertion.env.EXPECTED_TAG, "${{ needs.determine-environment.outputs.image-tag }}");
  assert.doesNotMatch(assertion.run, /GITHUB_REF_NAME|GITHUB_SHA/);
});

test("running revisions accept push, manual and release image tags", () => {
  for (const tag of ["main-f55838bd", "manual-f55838bdd09738d8f441baed178ba814feaa89a9", "v1.2.3"]) {
    const result = runRevisionAssertion(tag, `shorts australia-southeast2-docker.pkg.dev/fixture-project/shorted/shorts:${tag}`);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
});

test("running revision assertion still rejects deployment drift", () => {
  const result = runRevisionAssertion("manual-f55838bdd09738d8f441baed178ba814feaa89a9", "shorts australia-southeast2-docker.pkg.dev/fixture-project/shorted/shorts:main-f55838bd");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /rollout did not take effect/);
});

test("running revision assertion still fails when gcloud reports no services", () => {
  const result = runRevisionAssertion("main-f55838bd", "");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /inspected 0 services/);
});

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

  // Tracked content, not the working tree. `existsSync` here failed for anyone
  // holding a stray untracked terraform/environments/dev directory — green in
  // CI, red on their machine — and a guard that only fails locally is what
  // teaches people to push with --no-verify.
  assert.deepEqual(trackedUnder("terraform/environments/dev"), []);
  assert.deepEqual(trackedUnder("terraform/modules/preview"), []);
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
    /retire-dev-bucket-urls/,
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

// Images are published by ONE bake (docker-bake.hcl) so the shared Go module
// compiles once. The old shape — a 12-way docker matrix plus two ko jobs —
// serialized for over an hour on a single runner and failed the whole release
// whenever one slot stalled (2026-10-07). Guard the shape, not the count.
test("every image is published by the single bake job, and the deploy gates on it", () => {
  assert.ok(workflow.jobs["build-images"], "build-images job missing");
  assert.equal(workflow.jobs["build-docker-images"], undefined, "the per-image docker matrix must stay gone");
  assert.equal(workflow.jobs["build-ko-images"], undefined, "the ko jobs must stay gone");
  const bake = step("build-images", "Build and push all images");
  assert.match(bake.run, /docker buildx bake --file docker-bake\.hcl .*--push/);
  assert.equal(bake.env.REGISTRY, "${{ env.ARTIFACT_REGISTRY }}/${{ needs.determine-environment.outputs.project-id }}/shorted");
  assert.equal(bake.env.IMAGE_TAG, "${{ needs.determine-environment.outputs.image-tag }}");
  assert.equal(bake.env.PLATFORM, "linux/amd64");
  assert.equal(bake.env.STEALTH_PAT, "${{ secrets.STEALTH_PAT }}", "the private Go module needs the token as a bake secret");
  for (const job of ["terraform-plan", "run-tests"]) {
    assert.ok(workflow.jobs[job].needs.includes("build-images"), `${job} must wait for build-images`);
  }
  assert.match(String(workflow.jobs["terraform-plan"].if).replace(/\s+/g, " "), /needs\.build-images\.result == 'success' \|\| needs\.build-images\.result == 'skipped'/);
});

test("the bake publishes every image Terraform consumes, under the names it expects", () => {
  const bake = readFileSync(new URL("../../docker-bake.hcl", import.meta.url), "utf8");
  const vars = readFileSync(new URL("../../terraform/environments/prod/variables.tf", import.meta.url), "utf8");
  const images = [...vars.matchAll(/^variable "([a-z_]+)_image"/gm)].map((m) => m[1].replace(/_/g, "-"))
    .map((n) => (n === "shorts-api" ? "shorts" : n));
  for (const name of images) {
    assert.match(bake, new RegExp(`^target "${name}" \\{`, "m"), `docker-bake.hcl must define target "${name}" (terraform var *_image)`);
    assert.match(bake, new RegExp(`tags\\s+=\\s+tags\\("${name}"\\)`), `target "${name}" must publish under its own repository name`);
  }
  // Every Go target shares the one Dockerfile and its builder stage.
  const goDockerfile = readFileSync(new URL("../../services/images.Dockerfile", import.meta.url), "utf8");
  for (const target of bake.match(/inherits = \["_go"\]\s+target\s+=\s+"([a-z-]+)"/g).map((m) => m.match(/"([a-z-]+)"$/)[1])) {
    assert.match(goDockerfile, new RegExp(`^FROM .* AS ${target}$`, "m"), `images.Dockerfile must have a stage named ${target}`);
  }
  assert.equal((goDockerfile.match(/^FROM .* AS builder$/gm) ?? []).length, 1, "exactly one Go builder stage");
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
test("the vercel promote requires passing tests even with the infrastructure fallback", () => {
  const vercel = workflow.jobs?.["deploy-vercel-prod"];
  assert.ok(vercel, "missing deploy-vercel-prod job");
  const needs = vercel.needs ?? [];
  assert.ok(
    needs.includes("terraform-apply") || needs.includes("run-tests"),
    "deploy-vercel-prod must depend on terraform-apply (which is gated) or on run-tests directly",
  );
  assert.ok(needs.includes("run-tests"), "always() requires an explicit direct test dependency");
  assert.match(String(vercel.if ?? ""), /needs\.run-tests\.result == 'success'/);
  assert.match(String(vercel.if ?? ""), /github\.event\.inputs\.plan_only != 'true'/);
  assert.match(
    String(vercel.if ?? "").replace(/\s+/g, " "),
    /github\.event_name != 'pull_request'/,
    "pull requests must never reach the production promotion job",
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
