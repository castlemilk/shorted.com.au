import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

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

test("report extractor defaults cap paid Gemini run sizes", () => {
  assert.match(variableBlock("director_limit"), /default\s+=\s+20/);
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

  assert.match(reportsJob, /name\s+=\s+"GEMINI_MAX_RUN_ITEMS"[\s\S]*?value\s+=\s+tostring\(var\.reports_limit\)/);
  assert.match(reportsJob, /name\s+=\s+"GEMINI_MAX_RUN_WORKERS"[\s\S]*?value\s+=\s+"2"/);
  assert.match(reportsJob, /args\s+=\s+\[[\s\S]*?"--workers", "2"[\s\S]*?"--max-pages", "6"/);
});

test("production keeps report extractor limits explicit", () => {
  const start = prodMainTf.indexOf('module "report_extractor"');
  assert.ok(start >= 0, "prod report_extractor module should exist");
  const next = prodMainTf.indexOf("\nmodule ", start + 1);
  const block = prodMainTf.slice(start, next > -1 ? next : prodMainTf.length);

  assert.match(block, /director_limit\s+=\s+20/);
  assert.match(block, /reports_limit\s+=\s+10/);
});
