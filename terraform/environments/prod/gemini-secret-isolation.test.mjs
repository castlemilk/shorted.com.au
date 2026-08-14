import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const prodMainTf = readFileSync(new URL("./main.tf", import.meta.url), "utf8");
const chatModuleTf = readFileSync(new URL("../../modules/chat-service/main.tf", import.meta.url), "utf8");
const chatVarsTf = readFileSync(new URL("../../modules/chat-service/variables.tf", import.meta.url), "utf8");
// news moved onto the shared `shorted-job` module (jobs consolidation cleanup 1);
// it wires its Gemini secret through the generic `secret_env` map rather than a
// dedicated `gemini_secret_name` variable.
const shortedJobModuleTf = readFileSync(new URL("../../modules/shorted-job/main.tf", import.meta.url), "utf8");
const reportModuleTf = readFileSync(new URL("../../modules/report-extractor/main.tf", import.meta.url), "utf8");
const reportVarsTf = readFileSync(new URL("../../modules/report-extractor/variables.tf", import.meta.url), "utf8");

function moduleBlock(name) {
  const start = prodMainTf.indexOf(`module "${name}"`);
  assert.ok(start >= 0, `${name} module should exist`);
  const next = prodMainTf.indexOf("\nmodule ", start + 1);
  return prodMainTf.slice(start, next > -1 ? next : prodMainTf.length);
}

test("production uses separate Gemini secrets per paid workload", () => {
  assert.match(moduleBlock("chat_service"), /gemini_secret_name\s+=\s+"GEMINI_API_KEY_CHAT"/);
  assert.match(moduleBlock("shorted_job_news"), /GEMINI_API_KEY\s+=\s+"GEMINI_API_KEY_NEWS"/);
  assert.match(moduleBlock("report_extractor"), /gemini_secret_name\s+=\s+"GEMINI_API_KEY_REPORT_EXTRACTOR"/);
});

test("Gemini-backed modules take a configurable secret name", () => {
  for (const varsTf of [chatVarsTf, reportVarsTf]) {
    assert.match(varsTf, /variable "gemini_secret_name"/);
    assert.match(varsTf, /default\s+=\s+"GEMINI_API_KEY"/);
  }
});

test("Gemini-backed modules wire the configured secret into IAM and runtime env", () => {
  for (const moduleTf of [chatModuleTf, reportModuleTf]) {
    assert.match(moduleTf, /secret_id\s+=\s+var\.gemini_secret_name/);
    assert.match(moduleTf, /secret\s+=\s+var\.gemini_secret_name/);
  }
});

test("the shared shorted-job module wires secret_env into IAM and runtime env", () => {
  assert.match(shortedJobModuleTf, /for_each\s+=\s+toset\(values\(var\.secret_env\)\)/);
  assert.match(shortedJobModuleTf, /secret_id\s+=\s+each\.value/);
  assert.match(shortedJobModuleTf, /secret\s+=\s+env\.value/);
});
