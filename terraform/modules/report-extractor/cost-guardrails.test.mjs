import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Cost guardrails for the two paid-Gemini jobs. Run by repo-hygiene.yml's
// "Test repository hygiene tooling" node --test step (on any change under
// terraform/modules/** or to terraform/environments/prod/main.tf), so a change
// to any of these numbers is a reviewed, deliberate change to this file too.

const mainTf = readFileSync(new URL("./main.tf", import.meta.url), "utf8");
const variablesTf = readFileSync(new URL("./variables.tf", import.meta.url), "utf8");
const prodMainTf = readFileSync(new URL("../../environments/prod/main.tf", import.meta.url), "utf8");

function variableBlock(name) {
  const start = variablesTf.indexOf(`variable "${name}"`);
  assert.ok(start >= 0, `${name} variable should exist`);
  const next = variablesTf.indexOf('\nvariable "', start + 1);
  return variablesTf.slice(start, next > -1 ? next : variablesTf.length);
}

function resourceBlock(type, name) {
  const start = mainTf.indexOf(`resource "${type}" "${name}"`);
  assert.ok(start >= 0, `${type}.${name} should exist`);
  const next = mainTf.indexOf(`\nresource "`, start + 1);
  return mainTf.slice(start, next > -1 ? next : mainTf.length);
}

function prodReportExtractorBlock() {
  const start = prodMainTf.indexOf('module "report_extractor"');
  assert.ok(start >= 0, "prod report_extractor module should exist");
  const next = prodMainTf.indexOf("\nmodule ", start + 1);
  return prodMainTf.slice(start, next > -1 ? next : prodMainTf.length);
}

// The comment block directly above `module "report_extractor"`.
function prodReportExtractorComment() {
  const start = prodMainTf.indexOf('module "report_extractor"');
  const before = prodMainTf.slice(0, start).split("\n");
  const lines = [];
  for (let i = before.length - 2; i >= 0 && before[i].startsWith("#"); i--) lines.unshift(before[i]);
  return lines.join("\n");
}

function reportsArgs() {
  const job = resourceBlock("google_cloud_run_v2_job", "financial_report_extractor");
  const m = job.match(/args\s+=\s+\[([^\]]*)\]/);
  assert.ok(m, "financial_report_extractor should pass args");
  return m[1].split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
}

function argValue(args, flag) {
  const i = args.indexOf(flag);
  assert.ok(i >= 0 && i + 1 < args.length, `${flag} should be passed with a value`);
  return args[i + 1];
}

function envValue(block, name) {
  const m = block.match(new RegExp(`name\\s+=\\s+"${name}"\\s*\\n\\s*value\\s+=\\s+([^\\n]+)`));
  assert.ok(m, `${name} env should be set`);
  return m[1].trim();
}

test("report extractor defaults cap paid Gemini run sizes", () => {
  assert.match(variableBlock("director_limit"), /default\s+=\s+20/);
  // The module default stays small; production raises it explicitly below.
  assert.match(variableBlock("reports_limit"), /default\s+=\s+10/);
});

test("paid Gemini jobs do not retry automatically", () => {
  assert.match(resourceBlock("google_cloud_run_v2_job", "director_trade_extractor"), /max_retries\s+=\s+0/);
  assert.match(resourceBlock("google_cloud_run_v2_job", "financial_report_extractor"), /max_retries\s+=\s+0/);
  assert.match(resourceBlock("google_cloud_scheduler_job", "director_trade_extractor"), /retry_count\s+=\s+0/);
  assert.match(resourceBlock("google_cloud_scheduler_job", "financial_report_extractor"), /retry_count\s+=\s+0/);
});

test("paid Gemini jobs pass runtime budget caps to the container", () => {
  const directorJob = resourceBlock("google_cloud_run_v2_job", "director_trade_extractor");
  const reportsJob = resourceBlock("google_cloud_run_v2_job", "financial_report_extractor");

  assert.match(directorJob, /name\s+=\s+"GEMINI_MAX_RUN_ITEMS"[\s\S]*?value\s+=\s+tostring\(var\.director_limit\)/);
  assert.match(directorJob, /name\s+=\s+"GEMINI_MAX_RUN_WORKERS"[\s\S]*?value\s+=\s+"2"/);
  assert.match(directorJob, /args\s+=\s+\[[\s\S]*?"--workers", "2"/);

  // Contract 6.2: workers 4, with the container's own caps in step (the
  // container clamps --limit / --workers to GEMINI_MAX_RUN_ITEMS / _WORKERS,
  // so a CLI raise without the env raise silently does nothing).
  assert.equal(envValue(reportsJob, "GEMINI_MAX_RUN_ITEMS"), "tostring(var.reports_limit)");
  assert.equal(envValue(reportsJob, "GEMINI_MAX_RUN_WORKERS"), '"4"');
  const args = reportsArgs();
  assert.equal(argValue(args, "--limit"), "tostring(var.reports_limit)");
  assert.equal(argValue(args, "--workers"), "4");
  assert.equal(`"${argValue(args, "--workers")}"`, envValue(reportsJob, "GEMINI_MAX_RUN_WORKERS"));
  assert.equal(argValue(args, "--max-pages"), "8");
  assert.equal(argValue(args, "--recent"), "2");
  // Removed in 6.1: the order is now recent filers, then unparsed companies
  // by market cap, then the rest; the flag no longer exists in the script.
  assert.ok(!args.includes("--top-shorted-first"), "--top-shorted-first was removed");
});

test("the submit budget ends before the job timeout, with room for in-flight reports", () => {
  const reportsJob = resourceBlock("google_cloud_run_v2_job", "financial_report_extractor");
  const timeout = reportsJob.match(/timeout\s+=\s+"(\d+)s"/);
  assert.ok(timeout, "financial_report_extractor should set a timeout");
  const timeoutSeconds = Number(timeout[1]);
  assert.equal(timeoutSeconds, 7200);
  const budgetMinutes = Number(argValue(reportsArgs(), "--budget-min"));
  assert.equal(budgetMinutes, 90);
  // At most 4 reports are in flight when the budget elapses; 30 minutes is
  // the room they get to finish before Cloud Run kills the task.
  assert.ok(budgetMinutes * 60 + 30 * 60 <= timeoutSeconds, "budget + 30 min must fit in the timeout");
});

test("production keeps report extractor limits explicit", () => {
  const block = prodReportExtractorBlock();

  // Raised 20 -> 200 on purpose (2026-09-29): consensus extraction costs
  // ~$0.0006 a notice and fits ~18 min of the 60-min timeout at 2 workers.
  // A further raise should be as deliberate as this one.
  assert.match(block, /director_limit\s+=\s+200\b/);
  assert.match(prodReportExtractorComment() + block, /\$0\.0006 and ~11 s per notice/);
  // Raised 40 twice weekly -> 120 daily on purpose (contract 6.2): about 840
  // documents a week clears the ~2,146-company backlog in about three weeks,
  // then keeps up with ~83 statutory filings a week. It is affordable because
  // 6.1 stops paying for waste: statutory results documents only, one per
  // company per run, thinking tokens off, 8 pages. A further raise should be
  // as deliberate as this one.
  assert.match(block, /reports_limit\s+=\s+120\b/);
  assert.match(block, /reports_schedule\s+=\s+"0 14 \* \* \*"/);
});

test("the production comment carries the throughput justification", () => {
  const comment = prodReportExtractorBlock() + "\n" + prodReportExtractorComment();
  assert.match(comment, /840 documents a week/);
  assert.match(comment, /2,146-company backlog/);
  assert.match(comment, /83 statutory filings a week/);
  assert.match(comment, /First run's measured wall time/);
});
