import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const prodMainTf = readFileSync(new URL("./main.tf", import.meta.url), "utf8");
const chatModuleTf = readFileSync(new URL("../../modules/chat-service/main.tf", import.meta.url), "utf8");
const chatVarsTf = readFileSync(new URL("../../modules/chat-service/variables.tf", import.meta.url), "utf8");
const newsModuleTf = readFileSync(new URL("../../modules/news-aggregator/main.tf", import.meta.url), "utf8");
const newsVarsTf = readFileSync(new URL("../../modules/news-aggregator/variables.tf", import.meta.url), "utf8");
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
  assert.match(moduleBlock("news_aggregator"), /gemini_secret_name\s+=\s+"GEMINI_API_KEY_NEWS"/);
  assert.match(moduleBlock("report_extractor"), /gemini_secret_name\s+=\s+"GEMINI_API_KEY_REPORT_EXTRACTOR"/);
});

test("Gemini-backed modules take a configurable secret name", () => {
  for (const varsTf of [chatVarsTf, newsVarsTf, reportVarsTf]) {
    assert.match(varsTf, /variable "gemini_secret_name"/);
    assert.match(varsTf, /default\s+=\s+"GEMINI_API_KEY"/);
  }
});

test("Gemini-backed modules wire the configured secret into IAM and runtime env", () => {
  for (const moduleTf of [chatModuleTf, newsModuleTf, reportModuleTf]) {
    assert.match(moduleTf, /secret_id\s+=\s+var\.gemini_secret_name/);
    assert.match(moduleTf, /secret\s+=\s+var\.gemini_secret_name/);
  }
});
