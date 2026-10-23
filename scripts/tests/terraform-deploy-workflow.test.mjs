import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// The Cuttlefish registry is a second home for the images, so rigs can pull
// them with their control-plane token. It is never the deploy source: GAR is.
// So the mirror may not sit on the deploy's path, and its failure may not
// fail a deploy (a registry outage or a token the registry refuses is a
// warning on its own job).
test("the Cuttlefish mirror is off the deploy path and best-effort", () => {
  const mirror = workflow.jobs?.["mirror-images"];
  assert.ok(mirror, "mirror-images job missing");
  assert.deepEqual(mirror.needs, ["determine-environment", "build-images"]);
  assert.match(String(mirror.if), /github\.event_name != 'pull_request'/);
  assert.match(String(mirror.if), /needs\.build-images\.result == 'success'/);

  for (const [name, job] of Object.entries(workflow.jobs)) {
    const needs = [job.needs ?? []].flat();
    assert.ok(!needs.includes("mirror-images"), `${name} must not wait for the Cuttlefish mirror`);
  }

  const login = step("mirror-images", "Log in to the Cuttlefish registry (OIDC)");
  assert.equal(login.uses, "./.github/actions/cuttlefish-registry-login");
  assert.equal(login["continue-on-error"], true);
  const copy = step("mirror-images", "Mirror every baked image to the Cuttlefish registry");
  assert.equal(copy["continue-on-error"], true);
  assert.equal(copy.if, "steps.cuttlefish-login.outcome == 'success'");
  assert.equal(workflow.permissions["id-token"], "write", "the registry login needs the job's OIDC token");

  // Only build-images publishes, and it never talks to the second registry.
  const build = JSON.stringify(workflow.jobs["build-images"]);
  assert.doesNotMatch(build, /cuttlefish-registry/);
});

const logPath = join(tmpdir(), `mirror-docker-${process.pid}.log`);

function runMirror({ failOn = "" } = {}) {
  const copy = step("mirror-images", "Mirror every baked image to the Cuttlefish registry");
  return spawnSync("bash", ["-c", `docker() {
  echo "docker $*" >> "$DOCKER_LOG"
  if [ -n "$FAIL_ON" ] && [ "$1" = push ] && [[ "$*" == *"$FAIL_ON"* ]]; then return 1; fi
  return 0
}
${copy.run}`], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      SRC_REGISTRY: "gar.example/proj/shorted",
      DST_REGISTRY: "registry.example/shorted",
      IMAGE_TAG: "main-f55838bd",
      DOCKER_LOG: logPath,
      FAIL_ON: failOn,
    },
  });
}

test("the mirror copies every bake target, under both tags, and cleans up", () => {
  rmSync(logPath, { force: true });
  const result = runMirror();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const log = readFileSync(logPath, "utf8");
  const bake = readFileSync(new URL("../../docker-bake.hcl", import.meta.url), "utf8");
  const targets = [...bake.matchAll(/^target "([a-z][a-z0-9-]*)" \{$/gm)].map((m) => m[1]);
  assert.ok(targets.length >= 14, `expected every bake target, found ${targets.length}`);
  assert.ok(!targets.includes("_go"), "the shared _go template is not an image");
  for (const name of targets) {
    for (const tag of ["main-f55838bd", "latest"]) {
      assert.match(log, new RegExp(`docker pull -q gar\\.example/proj/shorted/${name}:${tag}\\n`));
      assert.match(log, new RegExp(`docker push -q registry\\.example/shorted/${name}:${tag}\\n`));
      assert.match(log, new RegExp(`docker image rm gar\\.example/proj/shorted/${name}:${tag} registry\\.example/shorted/${name}:${tag}\\n`));
    }
  }
  rmSync(logPath, { force: true });
});

test("a failed push is a warning that names the image, after every other image is tried", () => {
  rmSync(logPath, { force: true });
  const result = runMirror({ failOn: "/shorts:latest" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /::warning::Cuttlefish registry mirror failed for shorts:latest \(GAR is unaffected\)/);
  assert.match(readFileSync(logPath, "utf8"), /docker push -q registry\.example\/shorted\/take-writer:latest/);
  rmSync(logPath, { force: true });
});

// 2026-10-23: PR plans shared main's tfstate-<env> concurrency group. A group
// keeps one pending job and a newer pending job cancels it, so every PR push
// during a main deploy cancelled main's pending plan and, with it,
// terraform-apply. Main shipped Vercel only and the API stayed on an old build.
test("a pull request plan cannot cancel or block main's plan and apply", () => {
  const jobs = parse(workflowSource).jobs;
  const planGroup = jobs["terraform-plan"].concurrency.group;
  const applyGroup = jobs["terraform-apply"].concurrency.group;

  assert.match(planGroup, /github\.event_name == 'pull_request'/);
  assert.match(planGroup, /tfplan-pr-\{0\}', github\.event\.pull_request\.number/);
  assert.match(planGroup, /format\('tfstate-\{0\}', needs\.determine-environment\.outputs\.environment\)/);
  assert.equal(jobs["terraform-plan"].concurrency["cancel-in-progress"], false);
  assert.match(applyGroup, /^tfstate-\$\{\{ needs\.determine-environment\.outputs\.environment \}\}$/);

  const planRun = jobs["terraform-plan"].steps.find((s) => s.id === "plan").run;
  assert.match(planRun, /-lock=\$\{\{ github\.event_name == 'pull_request' && 'false' \|\| 'true' \}\}/);
});

// 2026-10-24: the chat service's Gemini key was rotated away from the shared
// GEMINI_API_KEY (the old chat-service logged the shared key in provider-error
// URLs). Every deploy re-syncs GEMINI_API_KEY_CHAT, so the sync must prefer the
// chat key's own Cuttlefish project secret, or the next deploy silently reverts the rotation.
test("the chat service's Gemini key is synced from its own secret, not the shared key", () => {
  const syncs = workflowSource.match(/ensure_gemini_secret "GEMINI_API_KEY_CHAT" "[^"]+"/g) ?? [];
  assert.equal(syncs.length, 2, "expected the plan and apply jobs to sync GEMINI_API_KEY_CHAT");
  for (const sync of syncs) {
    assert.equal(sync, 'ensure_gemini_secret "GEMINI_API_KEY_CHAT" "${GEMINI_API_KEY_CHAT:-$GEMINI_API_KEY}"');
  }
  for (const jobName of ["terraform-plan", "terraform-apply"]) {
    const job = parse(workflowSource).jobs[jobName];
    const exposes = job.steps.some((s) => s.env?.GEMINI_API_KEY_CHAT === "${{ secrets.GEMINI_API_KEY_CHAT }}");
    assert.ok(exposes, `${jobName} must expose secrets.GEMINI_API_KEY_CHAT to the sync step`);
  }
});

// Gemini keys reach Secret Manager only after scripts/validate-gemini-key.sh has
// seen them generate. Both sync jobs route the three Gemini secrets through
// ensure_gemini_secret, and nothing calls ensure_secret on them directly. On
// 2026-10-23 a key that could not generate was written, and a stale copy then
// replaced the working key.
const GEMINI_SECRETS = ["GEMINI_API_KEY_CHAT", "GEMINI_API_KEY_NEWS", "GEMINI_API_KEY_REPORT_EXTRACTOR"];
const SYNC_STEPS = [
  ["terraform-plan", "Ensure secrets exist in Secret Manager"],
  ["terraform-apply", "Ensure all secrets exist in Secret Manager"],
];

test("both sync jobs route the three Gemini secrets through the validating function", () => {
  for (const [jobName, stepName] of SYNC_STEPS) {
    const run = step(jobName, stepName).run;
    for (const name of GEMINI_SECRETS) {
      const calls = run.split("\n").filter((line) => line.trim().startsWith(`ensure_gemini_secret "${name}" `));
      assert.equal(calls.length, 1, `${jobName} must sync ${name} exactly once, through ensure_gemini_secret`);
    }
    // The key reaches the validator on stdin. As an argument it would show in ps for the whole call.
    assert.match(
      run,
      /printf '%s' "\$value" \| bash "\$GITHUB_WORKSPACE\/scripts\/validate-gemini-key\.sh" -\)/,
      `${jobName} must pipe the key to the validator on stdin before writing it`,
    );
    assert.doesNotMatch(
      run,
      /validate-gemini-key\.sh" "\$value"/,
      `${jobName} must not pass the key to the validator as an argument`,
    );
  }
});

test("no Gemini secret is written through ensure_secret without validation", () => {
  assert.doesNotMatch(
    workflowSource,
    /ensure_secret\s+"GEMINI_/,
    "a Gemini secret is written by ensure_secret directly, bypassing scripts/validate-gemini-key.sh",
  );
});

// The sync step itself, run as the runner runs it: its env block with every
// ${{ ... }} replaced by a fake value, under bash -e. Only the two scripts it
// calls are replaced. The ensure-secret stub records the names it was asked to
// write, and the validator stub returns the verdict the test sets. No network.
function runSyncStep(jobName, stepName, verdict) {
  const dir = mkdtempSync(join(tmpdir(), "gemini-sync-"));
  const log = join(dir, "written.log");
  const validatorLog = join(dir, "validated.log");
  mkdirSync(join(dir, "scripts"));
  // The value arrives on stdin, so the stub reads it. Otherwise printf can hit a closed pipe.
  writeFileSync(join(dir, "scripts", "ensure-secret.sh"), `#!/usr/bin/env bash\necho "$1" >> "${log}"\ncat >/dev/null\n`);
  // Records the arguments and the stdin of each validator call, so a test can see the key arrive on stdin.
  writeFileSync(
    join(dir, "scripts", "validate-gemini-key.sh"),
    `#!/usr/bin/env bash\necho "$*|$(cat)" >> "${validatorLog}"\necho "gemini key stub: ${verdict.label}"\nexit ${verdict.rc}\n`,
  );
  const stepDef = step(jobName, stepName);
  const env = { PATH: process.env.PATH, GITHUB_WORKSPACE: dir };
  for (const [key, value] of Object.entries(stepDef.env ?? {})) {
    env[key] = String(value).replace(/\$\{\{[^}]*\}\}/g, `fake-${key.toLowerCase()}`);
  }
  try {
    const result = spawnSync("bash", ["-e", "-c", stepDef.run], { env, encoding: "utf8", cwd: dir });
    const written = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
    const validated = existsSync(validatorLog) ? readFileSync(validatorLog, "utf8").split("\n").filter(Boolean) : [];
    return { status: result.status, output: (result.stdout ?? "") + (result.stderr ?? ""), written, validated };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const [jobName, stepName] of SYNC_STEPS) {
  test(`${jobName} writes a Gemini key only when it generates, and a refused key never fails the deploy`, () => {
    const passing = runSyncStep(jobName, stepName, { rc: 0, label: "ok" });
    assert.equal(passing.status, 0, passing.output);
    for (const name of GEMINI_SECRETS) {
      assert.ok(passing.written.includes(name), `${name} must be written when the validator passes`);
    }

    for (const verdict of [
      { rc: 2, label: "rejected: ACCESS_TOKEN_TYPE_UNSUPPORTED", title: "Gemini key not synced" },
      { rc: 3, label: "unverified: HTTP 503", title: "Gemini key not synced" },
      // An empty key is not a pass. It must never reach a write, and it leaves its own warning.
      { rc: 4, label: "skipped (empty)", title: "Gemini key not set" },
    ]) {
      const refused = runSyncStep(jobName, stepName, verdict);
      assert.equal(refused.status, 0, `exit ${verdict.rc} must not fail the deploy:\n${refused.output}`);
      for (const name of GEMINI_SECRETS) {
        assert.ok(!refused.written.includes(name), `${name} must not be written when the validator exits ${verdict.rc}`);
        assert.match(
          refused.output,
          new RegExp(`::warning title=${verdict.title}::${name}: `),
          `${name} must leave a warning when the validator exits ${verdict.rc}`,
        );
      }
      assert.ok(refused.written.includes("OPENAI_API_KEY"), "the non-Gemini secrets must still sync");
      assert.ok(refused.written.includes("INTERNAL_SERVICE_SECRET"), "the non-Gemini secrets must still sync");
    }
  });
}

test("both sync jobs pass each Gemini key to the validator on stdin, never as an argument", () => {
  for (const [jobName, stepName] of SYNC_STEPS) {
    const passing = runSyncStep(jobName, stepName, { rc: 0, label: "ok" });
    assert.deepEqual(
      passing.validated,
      ["-|fake-gemini_api_key_chat", "-|fake-gemini_api_key", "-|fake-gemini_api_key"],
      `${jobName} must validate chat, news and report, each with - as the only argument and the key on stdin`,
    );
  }
});

// The sync step with the REAL validator and REAL ensure-secret.sh. Only gcloud and curl
// are faked, on PATH. curl answers 200 with a text reply, so a key passes validation only
// when the validator really sends it in the header. gcloud records each version it is asked
// to add, with the bytes it was given on stdin. Any base URL is loopback, so nothing leaves the machine.
// Every gcloud and curl call also records ps's view of its parent, so a test can see
// whether the key was in any process argument list. `extraEnv` and `transformRun` exist
// for the xtrace control, which runs the same step with the guard removed.
function runSyncStepWithRealScripts(jobName, stepName, geminiEnv, { extraEnv = {}, transformRun = (run) => run } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gemini-real-sync-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "gcloud"),
      `#!/usr/bin/env bash
echo "$*" >> "${dir}/gcloud.log"
ps -o args= -p $PPID >> "${dir}/ps.log" 2>/dev/null
case "$*" in
  "secrets describe "*) exit 0 ;;
  "secrets versions access latest "*) printf '%s' 'current-stub-value'; exit 0 ;;
  "secrets versions add "*) cat > "${dir}/added-$4"; exit 0 ;;
  *) exit 0 ;;
esac
`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(bin, "curl"),
      `#!/usr/bin/env bash
echo "$*" >> "${dir}/curl-args.log"
ps -o args= -p $PPID >> "${dir}/ps.log" 2>/dev/null
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
cat >> "${dir}/curl-header.log"
printf '%s' '{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}' > "$out"
printf '200'
`,
      { mode: 0o755 },
    );
    const stepDef = step(jobName, stepName);
    const env = {
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_WORKSPACE: repoRoot,
      GEMINI_VALIDATE_BASE_URL: "http://127.0.0.1:9/v1beta",
      GEMINI_VALIDATE_RETRY_DELAY_SEC: "0",
    };
    for (const [key, value] of Object.entries(stepDef.env ?? {})) {
      env[key] = String(value).replace(/\$\{\{[^}]*\}\}/g, `fake-${key.toLowerCase()}`);
    }
    Object.assign(env, geminiEnv, extraEnv);
    const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", transformRun(stepDef.run)], {
      env,
      encoding: "utf8",
      cwd: dir,
    });
    const read = (name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : "");
    const added = {};
    for (const name of readdirSync(dir)) {
      if (name.startsWith("added-")) added[name.slice("added-".length)] = read(name);
    }
    return {
      status: result.status,
      output: (result.stdout ?? "") + (result.stderr ?? ""),
      gcloud: read("gcloud.log").split("\n").filter(Boolean),
      curlArgs: read("curl-args.log"),
      curlHeaders: read("curl-header.log").split("\n").filter(Boolean),
      psLog: read("ps.log"),
      added,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const [jobName, stepName] of SYNC_STEPS) {
  test(`${jobName} validates a Gemini key through the real scripts, and writes it only where the job may write`, () => {
    const key = "FAKE-chain-key-0001-not-real";
    const result = runSyncStepWithRealScripts(jobName, stepName, { GEMINI_API_KEY: key, GEMINI_API_KEY_CHAT: "" });
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(
      result.curlHeaders,
      [`x-goog-api-key: ${key}`, `x-goog-api-key: ${key}`, `x-goog-api-key: ${key}`],
      "each of the three Gemini secrets is validated once, with the key in the header",
    );
    assert.ok(!result.curlArgs.includes(key), "the key must not be in curl's argument list");
    assert.ok(!result.gcloud.some((line) => line.includes(key)), "the key must not be in gcloud's argument list");

    const geminiAdded = Object.keys(result.added).filter((name) => name.startsWith("GEMINI_API_KEY")).sort();
    if (jobName === "terraform-apply") {
      assert.deepEqual(geminiAdded, [...GEMINI_SECRETS].sort(), "the apply job writes all three Gemini secrets");
      for (const name of GEMINI_SECRETS) {
        assert.equal(result.added[name], key, `${name} must hold the validated key`);
      }
    } else {
      assert.deepEqual(geminiAdded, [], "the plan job is create-only, so it writes no Gemini version");
    }
  });

  test(`${jobName} writes no Gemini version for a key that is only CR/LF or empty, with the real scripts`, () => {
    for (const geminiEnv of [
      { GEMINI_API_KEY: "\r", GEMINI_API_KEY_CHAT: "\n" },
      { GEMINI_API_KEY: "\r\n", GEMINI_API_KEY_CHAT: "" },
      { GEMINI_API_KEY: "", GEMINI_API_KEY_CHAT: "" },
    ]) {
      const label = JSON.stringify(geminiEnv);
      const result = runSyncStepWithRealScripts(jobName, stepName, geminiEnv);
      assert.equal(result.status, 0, `${label} must not fail the deploy:\n${result.output}`);
      assert.deepEqual(
        Object.keys(result.added).filter((name) => name.startsWith("GEMINI_API_KEY")),
        [],
        `${label} must not write a Gemini version`,
      );
      assert.deepEqual(result.curlHeaders, [], `${label} must never reach the validator's network call`);
      for (const name of GEMINI_SECRETS) {
        assert.match(
          result.output,
          new RegExp(`::warning title=Gemini key not set::${name}: `),
          `${label}: ${name} must leave a warning`,
        );
      }
    }
  });
}

// Each sync step sends every value to ensure-secret.sh on stdin. As an argument, ps
// would show it for the whole of each gcloud call the script makes.
test("both sync steps send each secret value to ensure-secret.sh on stdin, never as an argument", () => {
  for (const [jobName, stepName] of SYNC_STEPS) {
    const run = step(jobName, stepName).run;
    assert.ok(
      run.includes(`ensure_secret() { printf '%s' "\${2:-}" | bash "$GITHUB_WORKSPACE/scripts/ensure-secret.sh" "$1" -; }`),
      `${jobName} must pipe ensure_secret's value to ensure-secret.sh on stdin`,
    );
    assert.doesNotMatch(run, /ensure-secret\.sh" "\$1" "\$\{2:-\}"/, `${jobName} must not pass the value as an argument`);
  }
});

// The sync steps run as the runner runs them, with the real validator and the real
// ensure-secret.sh. The key is padded, so the validator must refuse it before any
// request, and nothing may be versioned. Only the two calls each step makes are stubbed.
for (const [jobName, stepName] of SYNC_STEPS) {
  test(`${jobName} refuses a Gemini key with stray whitespace, with the real scripts: no request, no version`, () => {
    for (const key of [
      "  FAKE-padded-chain-0001-not-real",
      "FAKE-padded-chain-0001-not-real\t",
      "FAKE-padded-chain-0001-not-real ",
    ]) {
      const label = JSON.stringify(key);
      const result = runSyncStepWithRealScripts(jobName, stepName, { GEMINI_API_KEY: key, GEMINI_API_KEY_CHAT: "" });
      assert.equal(result.status, 0, `${label} must not fail the deploy:\n${result.output}`);
      assert.deepEqual(result.curlHeaders, [], `${label} must never reach the validator's network call`);
      assert.deepEqual(
        Object.keys(result.added).filter((name) => name.startsWith("GEMINI_API_KEY")),
        [],
        `${label} must not write a Gemini version`,
      );
      for (const name of GEMINI_SECRETS) {
        assert.match(
          result.output,
          new RegExp(`::warning title=Gemini key not synced::${name}: gemini key [0-9a-f]{12}: rejected: malformed key \\(whitespace\\)`),
          `${label}: ${name} must leave a whitespace warning`,
        );
      }
      assert.ok(!result.output.includes(key), `${label} must not be printed`);
    }
  });
}

const PS_AVAILABLE = spawnSync("ps", ["-p", String(process.pid)]).status === 0;

// Control first: ps must show the step's own helper processes, or an absent key proves nothing.
for (const [jobName, stepName] of SYNC_STEPS) {
  test(`${jobName} keeps the Gemini key out of every process argument list, with the real scripts`, { skip: !PS_AVAILABLE }, () => {
    const key = "FAKE-argv-chain-0001-not-real";
    const result = runSyncStepWithRealScripts(jobName, stepName, { GEMINI_API_KEY: key, GEMINI_API_KEY_CHAT: "" });
    assert.equal(result.status, 0, result.output);
    assert.match(result.psLog, /ensure-secret\.sh/, `control: ps must show ensure-secret.sh:\n${result.psLog}`);
    assert.match(result.psLog, /validate-gemini-key\.sh/, `control: ps must show the validator:\n${result.psLog}`);
    assert.ok(!result.psLog.includes(key), `the key was in a process argument list:\n${result.psLog}`);
    assert.ok(!result.output.includes(key), "the key reached the step log");
  });
}

// bash -x, SHELLOPTS=xtrace and a BASH_ENV that sets -x all trace the step shell. Each
// sync step turns xtrace off as its first command, and the lines before it are comments.
const XTRACE_GUARD = "{ set +x; } 2>/dev/null";

for (const [jobName, stepName] of SYNC_STEPS) {
  test(`${jobName} turns xtrace off as its first command, before any key is handled`, () => {
    const first = step(jobName, stepName)
      .run.split("\n")
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith("#"));
    assert.equal(first, XTRACE_GUARD);
  });

  test(`${jobName} never traces a Gemini key into the step log, even with BASH_ENV that sets -x`, () => {
    const dir = mkdtempSync(join(tmpdir(), "gemini-xtrace-"));
    try {
      const bashEnv = join(dir, "bash-env.sh");
      writeFileSync(bashEnv, "set -x\n");
      const key = "FAKE-xtrace-chain-0001-not-real";
      const geminiEnv = { GEMINI_API_KEY: key, GEMINI_API_KEY_CHAT: "" };

      const result = runSyncStepWithRealScripts(jobName, stepName, geminiEnv, { extraEnv: { BASH_ENV: bashEnv } });
      assert.equal(result.status, 0, result.output);
      assert.equal(result.curlHeaders.length, 3, "the keys were validated, so the run reached the key handling");
      assert.ok(!result.output.includes(key), "the key reached the step log under BASH_ENV=set -x");

      // Control: with the guard removed, the same run does trace the key, so the clean run above means something.
      assert.ok(step(jobName, stepName).run.includes(XTRACE_GUARD), "the guard line must exist to be removed");
      const control = runSyncStepWithRealScripts(jobName, stepName, geminiEnv, {
        extraEnv: { BASH_ENV: bashEnv },
        transformRun: (run) => run.replace(XTRACE_GUARD, ":"),
      });
      assert.ok(control.output.includes(key), "control failed: without the guard, BASH_ENV=set -x should trace the key");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
