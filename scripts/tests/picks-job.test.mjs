// The shorted-picks job: the admin MCP server's run_picks_job tool runs it with
// an argv override built server-side (services/shorts/internal/jobmonitor/picks.go).
// These pin the infrastructure half of that contract — the half a refactor of
// main.tf could silently break — and the cross-module enum the Go side and the
// job's flag parser must agree on.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const prodMain = read("../../terraform/environments/prod/main.tf");
const picksGo = read("../../services/shorts/internal/jobmonitor/picks.go");
const adminGo = read("../../services/shorts/internal/mcp/admin.go");
const jobGo = read("../../services/jobs/internal/jobs/picks/job.go");

function block(kind, name) {
  const start = prodMain.indexOf(`${kind} "${name}"`);
  assert.ok(start >= 0, `${kind} ${name} should exist in prod main.tf`);
  const next = prodMain.indexOf("\n}\n", start);
  return prodMain.slice(start, next + 2);
}

const job = block("module", "shorted_job_picks");

test("the job name matches the constant the API is allowed to run with overrides", () => {
  const constant = /const PicksJobName = "([^"]+)"/.exec(picksGo)?.[1];
  assert.equal(constant, "shorted-picks");
  assert.match(job, new RegExp(`name\\s+=\\s+"${constant}"`));
});

test("the deployed args are the harmless refresh, so Run now can never pull fundamentals", () => {
  assert.match(job, /args\s+=\s+\["picks", "-mode", "refresh"\]/);
});

test("the override grant is run.developer on THIS job only, and the job stays in the Run-now map", () => {
  const grant = block("resource", 'google_cloud_run_v2_job_iam_member" "shorts_api_picks_overrides');
  assert.match(grant, /name\s+=\s+module\.shorted_job_picks\.job_name/);
  assert.match(grant, /role\s+=\s+"roles\/run\.developer"/);
  assert.match(grant, /module\.shorts_api\.service_account_email/);

  // Exactly three jobs carry the override role: validation, publish, picks.
  const developerGrants = prodMain.match(/role\s+=\s+"roles\/run\.developer"/g) ?? [];
  assert.equal(developerGrants.length, 3, "a fourth run.developer grant needs its own server-side argv builder");

  const runnable = prodMain.slice(prodMain.indexOf("admin_runnable_jobs = {"));
  const runnableMap = runnable.slice(0, runnable.indexOf("\n  }\n"));
  assert.match(runnableMap, /shorted_job_picks/);
});

test("the Go enum is exactly the modes the job's flag parser accepts", () => {
  const monitorModes = [...picksGo.matchAll(/PicksMode\w+\s+PicksMode = "([a-z]+)"/g)].map((m) => m[1]).sort();
  const parserModes = /fs\.String\("mode", modeAll, "([^"]+)"\)/.exec(jobGo)?.[1].split("|").map((s) => s.trim()).sort();
  assert.deepEqual(monitorModes, parserModes);
  assert.deepEqual(monitorModes, ["all", "filings", "fundamentals", "refresh"]);
  // The subcommand and flag name are constants, never caller input.
  assert.match(picksGo, /const picksSubcommand = "picks"/);
  assert.match(picksGo, /return \[\]string\{picksSubcommand, "-mode", string\(mode\)\}/);
});

test("the admin tools sit behind their own scope, and neither admin scope reads as public", () => {
  assert.match(adminGo, /ScopeJobsRun\s+=\s+"jobs:run"/);
  assert.match(adminGo, /AdminTool\{Name: "run_picks_job", Scope: ScopeJobsRun\}/);
  assert.match(adminGo, /AdminTool\{Name: "picks_job_status", Scope: ScopeJobsRun\}/);
  const scopes = [...adminGo.matchAll(/Scope\w+\s+=\s+"([a-z]+:[a-z]+)"/g)].map((m) => m[1]);
  assert.ok(scopes.length >= 2);
  for (const s of scopes) assert.doesNotMatch(s, /:read$/, `${s} would pass for a public read scope`);
});
