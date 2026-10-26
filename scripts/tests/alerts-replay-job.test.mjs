// The shorted-alerts-replay job: the admin MCP server's run_alerts_smoke_test
// tool runs it with an argv override built server-side
// (services/shorts/internal/jobmonitor/alerts_replay.go). These pin the
// infrastructure half of that contract, and the cross-module facts the Go side
// and the Terraform side must agree on.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const prodMain = read("../../terraform/environments/prod/main.tf");
const replayGo = read("../../services/shorts/internal/jobmonitor/alerts_replay.go");
const adminGo = read("../../services/shorts/internal/mcp/admin_alerts.go");
const vkeValues = read("../../deploy/kubernetes/jobs/chart/values.yaml");

function block(kind, name) {
  const start = prodMain.indexOf(`${kind} "${name}"`);
  assert.ok(start >= 0, `${kind} ${name} should exist in prod main.tf`);
  const next = prodMain.indexOf("\n}\n", start);
  return prodMain.slice(start, next + 2);
}

const job = block("module", "shorted_job_alerts_replay");

test("the job name matches the constant the API may run with overrides", () => {
  const constant = /const AlertsReplayJobName = "([^"]+)"/.exec(replayGo)?.[1];
  assert.equal(constant, "shorted-alerts-replay");
  assert.match(job, new RegExp(`name\\s+=\\s+"${constant}"`));
});

test("the job is never scheduled and never on the reporter's watch list", () => {
  assert.match(job, /schedule\s+=\s+""/);
  const watched = prodMain.match(/vke_reporter_watched_jobs\s*=\s*\{([\s\S]*?)\n\s*\}/)?.[1] ?? "";
  assert.doesNotMatch(watched, /shorted-alerts/, "a replay must not be reported as a run of the shorted-alerts monitor");
  // The VKE CronJob keeps its name; a Cloud Run twin under it would fail the cutover guard.
  assert.match(vkeValues, /^vkeNative:\s*\n\s+-\s+shorted-alerts\s*$/m);
});

test("the replay job is fenced to one owner's one day; the scheduled CronJob is not", () => {
  // The jobs binary refuses a live run without -date and -user when this is set
  // (services/jobs/internal/jobs/alerts/config.go). Only the replay job sets it.
  assert.match(job, /ALERTS_REPLAY_ONLY\s+=\s+"true"/);
  const cronBlock = vkeValues.slice(vkeValues.indexOf("\n  shorted-alerts:"));
  const cron = cronBlock.slice(0, cronBlock.indexOf("\n  shorted-", 5) > 0 ? cronBlock.indexOf("\n  shorted-", 5) : cronBlock.length);
  assert.ok(cron.includes("args: [\"alerts\"]"), "the CronJob block was not found");
  assert.doesNotMatch(cron, /ALERTS_REPLAY_ONLY/, "the scheduled sweep must not be fenced");
});

test("the deployed args are a dry run, so a bare execution sends no mail", () => {
  assert.match(job, /args\s+=\s+\["alerts", "-dry-run"\]/);
  // The live setting is the environment, and it is only reached by an override
  // whose argv has no -dry-run. That is the override's contract, pinned on the Go side.
  assert.match(job, /ALERTS_DRY_RUN\s+=\s+"false"/);
});

test("the override grant is run.developer on THIS job only, and the job is not in Run-now", () => {
  const grant = block("resource", 'google_cloud_run_v2_job_iam_member" "shorts_api_alerts_replay');
  assert.match(grant, /name\s+=\s+module\.shorted_job_alerts_replay\.job_name/);
  assert.match(grant, /role\s+=\s+"roles\/run\.developer"/);
  assert.match(grant, /module\.shorts_api\.service_account_email/);

  const runnable = prodMain.slice(prodMain.indexOf("admin_runnable_jobs = {"));
  const runnableMap = runnable.slice(0, runnable.indexOf("\n  }\n"));
  assert.doesNotMatch(runnableMap, /shorted_job_alerts_replay/);
});

test("the secrets are the ones the evaluator reads, and the database comes the usual way", () => {
  assert.match(job, /DATABASE_URL\s+=\s+"DATABASE_URL"/);
  for (const name of ["RESEND_API_KEY", "INTERNAL_SERVICE_SECRET", "UNSUBSCRIBE_SECRET"]) {
    assert.match(job, new RegExp(`${name}\\s+=\\s+"${name}"`));
  }
  assert.match(job, /SHORTS_API_URL\s+=\s+module\.shorts_api\.service_url/);
  assert.match(job, /max_retries\s+=\s+0/, "a retry would re-send mail the claim already recorded");
});

test("the argv builder is the evaluator's replay, with the canary off and the owner as the caller's uid", () => {
  assert.match(replayGo, /const alertsSubcommand = "alerts"/);
  assert.match(replayGo, /return \[\]string\{alertsSubcommand, "-date", date, "-user", userID, "-canary", "off"\}/);
  // The owner is the verified token's uid, and never a tool input.
  assert.match(adminGo, /AdminAlertsOperator/);
  assert.doesNotMatch(adminGo, /input\.user_id|UserID\s*=\s*in\./);
});

test("the admin alerts tools sit behind their own scopes and stay off the public server", () => {
  assert.match(adminGo, /AdminTool\{Name: RunAlertsSmokeTool, Scope: ScopeJobsRun\}|Name: RunAlertsSmokeTool, Scope: ScopeJobsRun/);
  assert.match(read("../../services/shorts/internal/mcp/admin_alerts.go"), /AlertsStatusTool\s+= "alerts_status"/);
});
