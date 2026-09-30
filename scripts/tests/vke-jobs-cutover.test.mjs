/// Guards the Cloud Run -> Kubernetes cutover of the scheduled jobs.
///
/// A job's schedule lives in TWO places while the migration is in flight: its
/// Cloud Scheduler trigger (terraform/environments/prod/main.tf) and its
/// CronJob (deploy/kubernetes/jobs/chart/values.yaml). Which one fires is
/// decided by two lists that must agree:
///
///   local.jobs_on_vke   (Terraform)  pauses the Cloud Scheduler trigger
///   enabled             (chart)      unsuspends the CronJob
///
/// A name in only the chart runs the job TWICE (both schedulers fire — two
/// ASIC ingests, two newsletters, two paid LLM passes). A name in only
/// Terraform runs it NOT AT ALL, and a paused Cloud Scheduler trigger raises no
/// Cloud Run alert, so the silence would be noticed only by Telesis' missed-run
/// check — if the monitor is registered. These tests make both mistakes
/// unmergeable.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const mainTf = readFileSync(join(repoRoot, "terraform/environments/prod/main.tf"), "utf8");
const values = readFileSync(join(repoRoot, "deploy/kubernetes/jobs/chart/values.yaml"), "utf8");

/** Strings in an HCL list `jobs_on_vke = [ "a", "b" ]` (comments allowed). */
function tfJobsOnVke() {
  const m = mainTf.match(/^\s*jobs_on_vke\s*=\s*\[([\s\S]*?)\]/m);
  assert.ok(m, "local.jobs_on_vke not found in terraform/environments/prod/main.tf");
  const body = m[1].replace(/#.*$/gm, "");
  return [...body.matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

/** Top-level `enabled:` — flow (`[a, b]`) or block (`- a`) form. */
function chartEnabled() {
  const flow = values.match(/^enabled:\s*\[([^\]]*)\]/m);
  if (flow) {
    return flow[1]
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  const block = values.match(/^enabled:\s*\n((?:\s+-\s+.*\n?)*)/m);
  assert.ok(block, "top-level `enabled:` not found in values.yaml");
  return [...block[1].matchAll(/^\s+-\s+["']?([^"'\s#]+)/gm)].map((x) => x[1]);
}

function chartSuspendAll() {
  const m = values.match(/^suspendAll:\s*(true|false)/m);
  assert.ok(m, "top-level `suspendAll:` not found in values.yaml");
  return m[1] === "true";
}

/** Keys of the top-level `jobs:` map (two-space indented, value on later lines). */
function chartJobs() {
  const start = values.search(/^jobs:\s*$/m);
  assert.ok(start >= 0, "top-level `jobs:` not found in values.yaml");
  const rest = values.slice(start).split("\n").slice(1);
  const names = [];
  for (const line of rest) {
    if (/^\S/.test(line)) break; // next top-level key
    const m = line.match(/^ {2}([a-z0-9][a-z0-9-]*):\s*$/);
    if (m) names.push(m[1]);
  }
  return names;
}

const sorted = (xs) => [...xs].sort();

test("the Terraform pause list and the chart's enabled list are the same set", () => {
  assert.deepEqual(
    sorted(tfJobsOnVke()),
    sorted(chartEnabled()),
    "local.jobs_on_vke (pauses Cloud Scheduler) and values.yaml `enabled` (unsuspends the CronJob) must match exactly",
  );
});

test("no name appears twice in either list", () => {
  for (const [what, list] of [
    ["local.jobs_on_vke", tfJobsOnVke()],
    ["values.yaml enabled", chartEnabled()],
  ]) {
    assert.equal(new Set(list).size, list.length, `${what} has a duplicate`);
  }
});

test("every cut-over name is a CronJob the chart defines", () => {
  const jobs = new Set(chartJobs());
  for (const name of tfJobsOnVke()) {
    assert.ok(jobs.has(name), `jobs_on_vke lists "${name}", which is not a job in values.yaml`);
  }
});

test("every CronJob has exactly one Cloud Scheduler pause wired to it", () => {
  const referenced = [...mainTf.matchAll(/contains\(local\.jobs_on_vke,\s*"([^"]+)"\)/g)].map((m) => m[1]);
  const jobs = chartJobs();
  assert.ok(jobs.length >= 21, `expected the full job set in values.yaml, found ${jobs.length}`);
  for (const name of jobs) {
    const n = referenced.filter((r) => r === name).length;
    assert.equal(n, 1, `CronJob "${name}" has ${n} contains(local.jobs_on_vke, "${name}") in main.tf — its Cloud Scheduler trigger could never be paused (0) or is ambiguous (>1)`);
  }
  for (const name of referenced) {
    assert.ok(jobs.includes(name), `main.tf pauses on "${name}", which the chart does not define`);
  }
});

test("a cut-over job cannot be held suspended by suspendAll", () => {
  if (tfJobsOnVke().length > 0) {
    assert.equal(
      chartSuspendAll(),
      false,
      "jobs_on_vke pauses Cloud Scheduler for some jobs while suspendAll=true keeps every CronJob suspended — those jobs would not run anywhere",
    );
  }
});

test("the parsers read the forms the runbook documents", () => {
  // Regression guard for the guard: if the file layout changes so the parsers
  // silently read nothing, the set-equality test above would pass vacuously.
  assert.ok(chartJobs().includes("shorts-data-sync"));
  assert.ok(/^\s*jobs_on_vke\s*=/m.test(mainTf));
  assert.ok(/^enabled:/m.test(values));
});


test("Paprika tracks the branch CI promotes after terraform-apply, never main", () => {
  // The 2026-09-30 incident: with the Application on main, merging a cutover
  // unsuspended its CronJobs at once, while a failed image push skipped the
  // Terraform apply that pauses the Cloud Scheduler triggers.
  const app = readFileSync(join(repoRoot, "deploy/kubernetes/jobs/paprika/application.yaml"), "utf8");
  assert.match(app, /^\s+revision:\s+deploy\/vke-jobs\s*$/m);
  const wf = readFileSync(join(repoRoot, ".github/workflows/terraform-deploy.yml"), "utf8");
  const start = wf.indexOf("\n  bump-vke-jobs-image:\n");
  assert.ok(start >= 0, "bump-vke-jobs-image job missing");
  const job = wf.slice(start, wf.indexOf("\n  deploy-vercel-prod:\n", start));
  assert.match(job, /needs:\s*\[[^\]]*terraform-apply[^\]]*\]/);
  assert.match(job, /needs\.terraform-apply\.result == 'success'/);
  assert.match(job, /ref:\s*\$\{\{ github\.sha \}\}/, "must promote the applied commit, not main's tip");
  assert.match(job, /refs\/heads\/\$\{branch\}/);
  assert.match(job, /merge-base --is-ancestor/, "must refuse to move the branch backwards");
  assert.doesNotMatch(job, /push origin HEAD:main/, "promotion must not write to main");
});


test("every Cloud Run job the reporter watches has its run.viewer grant", () => {
  // A chart job's `cloudRun.job` is listed by cronjob-reporter until it is cut
  // over. Without the job-level grant the listing 403s, its runs go
  // unreported, and its Telesis monitor pages as MISSED.
  const chartJobs = [...values.matchAll(/^\s{4}cloudRun:\s*\n\s{6}job:\s*([a-z0-9-]+)/gm)].map((m) => m[1]);
  assert.ok(chartJobs.length >= 14, `expected cloudRun mappings in values.yaml, found ${chartJobs.length}`);
  const block = mainTf.match(/vke_reporter_watched_jobs\s*=\s*\{([\s\S]*?)\n\s*\}/);
  assert.ok(block, "local.vke_reporter_watched_jobs not found");
  const granted = new Set([...block[1].matchAll(/"([a-z0-9-]+)"\s*=/g)].map((m) => m[1]));
  for (const job of new Set(chartJobs)) {
    assert.ok(granted.has(job), `Cloud Run job "${job}" is watched by the reporter but has no run.viewer grant in main.tf`);
  }
});
