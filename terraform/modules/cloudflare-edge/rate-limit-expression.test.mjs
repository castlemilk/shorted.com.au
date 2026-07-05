import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const mainTf = readFileSync(new URL("./main.tf", import.meta.url), "utf8");
const variablesTf = readFileSync(new URL("./variables.tf", import.meta.url), "utf8");
const prodMainTf = readFileSync(new URL("../../environments/prod/main.tf", import.meta.url), "utf8");
const prodVariablesTf = readFileSync(new URL("../../environments/prod/variables.tf", import.meta.url), "utf8");
const prodImportCloudflareSh = readFileSync(
  new URL("../../environments/prod/import-existing-cloudflare.sh", import.meta.url),
  "utf8",
);
const shortDataSyncPy = readFileSync(
  new URL("../../../services/short-data-sync/main.py", import.meta.url),
  "utf8",
);

test("strict Cloudflare rate limit only targets the API hostname", () => {
  const rateLimitBlockMatch = mainTf.match(
    /description\s+=\s+"Rate limit — API host usage"[\s\S]*?ratelimit\s+=\s+\{/,
  );
  assert.ok(rateLimitBlockMatch, "rate-limit rule block should be present");

  const rateLimitBlock = rateLimitBlockMatch[0];
  assert.match(rateLimitBlock, /expression\s+=\s+local\.api_rate_limit_expression/);
  assert.match(mainTf, /api_rate_limit_host_expression\s+=\s+"http\.host eq \\"api\.shorted\.com\.au\\""/);
  assert.doesNotMatch(rateLimitBlock, /www\.shorted\.com\.au/);
  assert.doesNotMatch(rateLimitBlock, /\/api\/search|\/api\/community|\/api\/stripe|\/chat\.v1\.ChatService/);
});

test("Cloudflare testing bypass requires both a test user-agent and secret header", () => {
  assert.match(mainTf, /rate_limit_testing_bypass_clause/);
  assert.match(mainTf, /var\.rate_limit_testing_bypass_secret != ""/);
  assert.match(mainTf, /http\.user_agent contains \\"\$\{var\.rate_limit_testing_bypass_user_agent\}\\"/);
  assert.match(
    mainTf,
    /any\(http\.request\.headers\[\\"\$\{var\.rate_limit_testing_bypass_header_name\}\\"\]\[\*\] eq \\"\$\{var\.rate_limit_testing_bypass_secret\}\\"\)/,
  );
  assert.doesNotMatch(mainTf, /not \(http\.user_agent contains \\"[^"]+\\"\)/);
});

test("testing bypass inputs are explicit and safe by default", () => {
  assert.match(variablesTf, /variable "rate_limit_testing_bypass_secret"/);
  assert.match(variablesTf, /sensitive\s+=\s+true/);
  assert.match(variablesTf, /default\s+=\s+""/);
  assert.match(variablesTf, /variable "rate_limit_testing_bypass_header_name"/);
  assert.match(variablesTf, /default\s+=\s+"x-shorted-testing-bypass"/);
  assert.match(variablesTf, /variable "rate_limit_testing_bypass_user_agent"/);
  assert.match(variablesTf, /default\s+=\s+"Shorted-E2E"/);
});

test("production environment passes testing bypass inputs into Cloudflare edge module", () => {
  assert.match(prodVariablesTf, /variable "rate_limit_testing_bypass_secret"/);
  assert.match(prodVariablesTf, /sensitive\s+=\s+true/);
  assert.match(prodMainTf, /rate_limit_testing_bypass_secret\s+=\s+var\.rate_limit_testing_bypass_secret/);
  assert.match(prodMainTf, /rate_limit_testing_bypass_header_name\s+=\s+var\.rate_limit_testing_bypass_header_name/);
  assert.match(prodMainTf, /rate_limit_testing_bypass_user_agent\s+=\s+var\.rate_limit_testing_bypass_user_agent/);
});

test("frontend and API app endpoints skip bot challenges without skipping WAF or rate limits", () => {
  const skipRulesetMatch = mainTf.match(
    /resource "cloudflare_ruleset" "app_api_security_skip" \{[\s\S]*?\n\}/,
  );
  assert.ok(skipRulesetMatch, "app API security skip ruleset should be present");

  const skipRuleset = skipRulesetMatch[0];
  assert.match(skipRuleset, /phase\s+=\s+"http_request_firewall_custom"/);
  assert.match(skipRuleset, /action\s+=\s+"skip"/);
  assert.match(skipRuleset, /phases\s+=\s+\["http_request_sbfm"\]/);
  assert.match(skipRuleset, /products\s+=\s+\["bic", "securityLevel"\]/);

  assert.match(skipRuleset, /\$\{var\.domain\}/);
  assert.match(prodMainTf, /domain\s+=\s+"api\.shorted\.com\.au"/);
  assert.match(skipRuleset, /shorted\.com\.au/);
  assert.match(skipRuleset, /\/shorts\.v1alpha1\./);
  assert.match(skipRuleset, /\/marketdata\.v1\./);
  assert.match(skipRuleset, /\/chat\.v1\./);
  assert.match(skipRuleset, /\/api\/auth\//);
  assert.match(skipRuleset, /\/api\/market-data\//);

  assert.doesNotMatch(skipRuleset, /http_ratelimit/);
  assert.doesNotMatch(skipRuleset, /http_request_firewall_managed/);
  assert.doesNotMatch(skipRuleset, /"waf"/);
  assert.doesNotMatch(skipRuleset, /"rateLimit"/);
});

test("production Cloudflare import sweep covers the app API security skip ruleset", () => {
  assert.match(
    prodImportCloudflareSh,
    /module\.edge\.cloudflare_ruleset\.app_api_security_skip\[0\]/,
  );
});

test("Cloudflare caches stock detail HTML before the broad HTML bypass", () => {
  assert.match(variablesTf, /variable "stock_page_cache_ttl"/);

  const stockRuleIndex = mainTf.indexOf("Cache public stock detail HTML pages at edge");
  const htmlBypassIndex = mainTf.indexOf("Bypass edge cache for HTML pages");
  assert.ok(stockRuleIndex > 0, "stock detail HTML cache rule should be present");
  assert.ok(htmlBypassIndex > 0, "broad HTML bypass rule should be present");
  assert.ok(
    stockRuleIndex < htmlBypassIndex,
    "stock detail cache rule must run before broad HTML bypass",
  );

  const stockRuleStart = mainTf.lastIndexOf("action      = \"set_cache_settings\"", stockRuleIndex);
  const stockRule = mainTf.slice(stockRuleStart, htmlBypassIndex);
  assert.ok(
    stockRule.includes('starts_with(http.request.uri.path, \\"/shorts/\\")'),
  );
  assert.ok(stockRule.includes('not http.request.uri.path contains \\"/news\\"'));
  assert.ok(
    stockRule.includes('not http.request.uri.path contains \\"/community\\"'),
  );
  assert.match(stockRule, /cache\s+=\s+true/);
  assert.match(stockRule, /mode\s+=\s+"override_origin"/);
  assert.match(stockRule, /value\s+=\s+var\.stock_page_cache_ttl/);
  assert.doesNotMatch(stockRule, /\/api\//);
});

test("daily short data sync invalidates the shared stock data cache tag", () => {
  assert.match(shortDataSyncPy, /"tag": "shorts-data"/);
  assert.match(shortDataSyncPy, /"path": "\/,\/top,\/news,\/screener,\/industry,\/shorts\/\[stockCode\]"/);
  assert.match(shortDataSyncPy, /"flush": "shorts"/);
});
