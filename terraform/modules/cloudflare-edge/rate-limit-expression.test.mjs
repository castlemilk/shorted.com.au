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
const terraformDeployYml = readFileSync(
  new URL("../../../.github/workflows/terraform-deploy.yml", import.meta.url),
  "utf8",
);
// The DEPLOYED sync script (the short-data-sync image builds from
// services/daily-sync/, NOT services/short-data-sync/ — the latter is a
// never-deployed sibling kept only as reference).
const shortDataSyncPy = readFileSync(
  new URL(
    "../../../services/daily-sync/deprecated/comprehensive_daily_sync.py",
    import.meta.url,
  ),
  "utf8",
);

function ruleBlockByDescription(description) {
  const descriptionIndex = mainTf.indexOf(`description = "${description}"`);
  assert.ok(descriptionIndex > 0, `${description} rule should be present`);

  const start = mainTf.lastIndexOf("action      = \"set_cache_settings\"", descriptionIndex);
  const nextRule = mainTf.indexOf("\n    {", descriptionIndex + description.length);
  return mainTf.slice(start, nextRule > -1 ? nextRule : mainTf.length);
}

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
  const localsBlock = mainTf.match(/locals \{[\s\S]*?\n\}/)?.[0] ?? "";

  assert.match(localsBlock, /api_rate_limit_expression\s+=\s+local\.api_rate_limit_host_expression/);
  assert.doesNotMatch(localsBlock, /api_rate_limit_expression\s+=\s+"\$\{local\.api_rate_limit_host_expression\} and not \$\{local\.testing_bypass_expression\}"/);
  assert.doesNotMatch(localsBlock, /rate_limit_testing_bypass_clause/);
  assert.match(mainTf, /testing_bypass_expression/);
  assert.match(mainTf, /var\.rate_limit_testing_bypass_secret != ""/);
  assert.match(mainTf, /http\.user_agent contains \\"\$\{var\.rate_limit_testing_bypass_user_agent\}\\"/);
  assert.match(
    mainTf,
    /any\(http\.request\.headers\[\\"\$\{var\.rate_limit_testing_bypass_header_name\}\\"\]\[\*\] eq \\"\$\{var\.rate_limit_testing_bypass_secret\}\\"\)/,
  );
});

test("testing bypass inputs are explicit and safe by default", () => {
  assert.match(variablesTf, /variable "rate_limit_testing_bypass_secret"/);
  assert.match(variablesTf, /sensitive\s+=\s+true/);
  assert.match(variablesTf, /default\s+=\s+""/);
  assert.match(variablesTf, /variable "rate_limit_testing_bypass_header_name"/);
  assert.match(variablesTf, /default\s+=\s+"x-shorted-testing-bypass"/);
  assert.match(variablesTf, /variable "rate_limit_testing_bypass_user_agent"/);
  assert.match(variablesTf, /default\s+=\s+"Shorted-E2E"/);
  assert.match(
    mainTf,
    /: "false"/,
  );
  assert.doesNotMatch(mainTf, /__shorted-testing-bypass-disabled\.invalid__/);
});

test("production environment passes testing bypass inputs into Cloudflare edge module", () => {
  assert.match(prodVariablesTf, /variable "rate_limit_testing_bypass_secret"/);
  assert.match(prodVariablesTf, /sensitive\s+=\s+true/);
  assert.match(prodMainTf, /rate_limit_testing_bypass_secret\s+=\s+var\.rate_limit_testing_bypass_secret/);
  assert.match(prodMainTf, /rate_limit_testing_bypass_header_name\s+=\s+var\.rate_limit_testing_bypass_header_name/);
  assert.match(prodMainTf, /rate_limit_testing_bypass_user_agent\s+=\s+var\.rate_limit_testing_bypass_user_agent/);
});

test("Cloudflare SSR bypass requires both the SSR user-agent and secret header", () => {
  const localsBlock = mainTf.match(/locals \{[\s\S]*?\n\}/)?.[0] ?? "";

  // The SSR bypass must never be folded into the rate-limit expression itself
  // (Cloudflare's basic rate-limit phase rejects header/user-agent fields).
  assert.match(localsBlock, /api_rate_limit_expression\s+=\s+local\.api_rate_limit_host_expression/);
  assert.doesNotMatch(localsBlock, /rate_limit_ssr_bypass_clause/);

  assert.match(mainTf, /ssr_bypass_expression/);
  assert.match(mainTf, /var\.rate_limit_ssr_bypass_secret != ""/);
  assert.match(mainTf, /http\.user_agent contains \\"\$\{var\.rate_limit_ssr_bypass_user_agent\}\\"/);
  assert.match(
    mainTf,
    /any\(http\.request\.headers\[\\"\$\{var\.rate_limit_ssr_bypass_header_name\}\\"\]\[\*\] eq \\"\$\{var\.rate_limit_ssr_bypass_secret\}\\"\)/,
  );
  // UA-only bypass is never acceptable: the UA check must be conjoined with
  // the secret header check inside a single parenthesised clause.
  const ssrLocal = mainTf.match(/ssr_bypass_expression\s+=\s+var\.rate_limit_ssr_bypass_secret[^\n]*/)?.[0] ?? "";
  assert.match(ssrLocal, /contains[\s\S]*and[\s\S]*any\(http\.request\.headers/);
});

test("SSR bypass inputs are explicit and disabled by default", () => {
  assert.match(variablesTf, /variable "rate_limit_ssr_bypass_secret"/);
  assert.match(
    variablesTf,
    /variable "rate_limit_ssr_bypass_secret"[\s\S]*?sensitive\s+=\s+true[\s\S]*?default\s+=\s+""/,
  );
  assert.match(variablesTf, /variable "rate_limit_ssr_bypass_header_name"/);
  assert.match(variablesTf, /default\s+=\s+"x-shorted-ssr-bypass"/);
  assert.match(variablesTf, /variable "rate_limit_ssr_bypass_user_agent"/);
  assert.match(variablesTf, /default\s+=\s+"shorted-web-ssr"/);

  // Disabled state collapses to a literal false so the skip rule cannot match.
  const ssrLocal = mainTf.match(/ssr_bypass_expression\s+=\s+var\.rate_limit_ssr_bypass_secret[^\n]*/)?.[0] ?? "";
  assert.match(ssrLocal, /: "false"$/);
});

test("testing and SSR bypasses are independent rules over the same skip ruleset", () => {
  const skipRulesetMatch = mainTf.match(
    /resource "cloudflare_ruleset" "app_api_security_skip" \{[\s\S]*?\n\}/,
  );
  assert.ok(skipRulesetMatch, "app API security skip ruleset should be present");
  const skipRuleset = skipRulesetMatch[0];

  assert.match(skipRuleset, /local\.testing_bypass_expression/);
  assert.match(skipRuleset, /local\.ssr_bypass_expression/);
  assert.match(skipRuleset, /Allow first-party Vercel SSR traffic/);

  // Both bypass rules skip the rate-limit phase; each carries its own secret.
  const ratelimitSkips = skipRuleset.match(/phases\s+=\s+\["http_request_sbfm", "http_ratelimit"\]/g) ?? [];
  assert.equal(ratelimitSkips.length, 2);

  // A request with both secrets matches both rules; neither rule references
  // the other's variables, so enabling one never enables the other.
  const ssrRuleIndex = skipRuleset.indexOf("Allow first-party Vercel SSR traffic");
  const ssrRuleStart = skipRuleset.lastIndexOf("action      = \"skip\"", ssrRuleIndex);
  const ssrRule = skipRuleset.slice(ssrRuleStart, ssrRuleIndex);
  assert.doesNotMatch(ssrRule, /testing_bypass_expression/);
});

test("production environment passes SSR bypass inputs into Cloudflare edge module", () => {
  assert.match(prodVariablesTf, /variable "rate_limit_ssr_bypass_secret"/);
  assert.match(
    prodVariablesTf,
    /variable "rate_limit_ssr_bypass_secret"[\s\S]*?sensitive\s+=\s+true/,
  );
  assert.match(prodMainTf, /rate_limit_ssr_bypass_secret\s+=\s+var\.rate_limit_ssr_bypass_secret/);
  assert.match(prodMainTf, /rate_limit_ssr_bypass_header_name\s+=\s+var\.rate_limit_ssr_bypass_header_name/);
  assert.match(prodMainTf, /rate_limit_ssr_bypass_user_agent\s+=\s+var\.rate_limit_ssr_bypass_user_agent/);
});

test("CI supplies both bypass secrets to terraform plan and apply", () => {
  const planEnvs = terraformDeployYml.match(
    /TF_VAR_rate_limit_ssr_bypass_secret: \$\{\{ secrets\.CLOUDFLARE_SSR_BYPASS_SECRET \}\}/g,
  ) ?? [];
  assert.equal(planEnvs.length, 2);
  const testingEnvs = terraformDeployYml.match(
    /TF_VAR_rate_limit_testing_bypass_secret: \$\{\{ secrets\.CLOUDFLARE_TESTING_BYPASS_SECRET \}\}/g,
  ) ?? [];
  assert.equal(testingEnvs.length, 2);
});

test("frontend and API app endpoints skip bot/browser challenges without broad WAF skips", () => {
  const skipRulesetMatch = mainTf.match(
    /resource "cloudflare_ruleset" "app_api_security_skip" \{[\s\S]*?\n\}/,
  );
  assert.ok(skipRulesetMatch, "app API security skip ruleset should be present");

  const skipRuleset = skipRulesetMatch[0];
  assert.match(skipRuleset, /phase\s+=\s+"http_request_firewall_custom"/);
  assert.match(skipRuleset, /action\s+=\s+"skip"/);
  assert.match(skipRuleset, /phases\s+=\s+\["http_request_sbfm"\]/);
  assert.match(skipRuleset, /phases\s+=\s+\["http_request_sbfm", "http_ratelimit"\]/);
  assert.match(skipRuleset, /products\s+=\s+\["bic", "securityLevel"\]/);
  assert.match(skipRuleset, /local\.testing_bypass_expression/);
  assert.match(skipRuleset, /Allow trusted E2E\/load-test traffic/);

  assert.match(skipRuleset, /\$\{var\.domain\}/);
  assert.match(prodMainTf, /domain\s+=\s+"api\.shorted\.com\.au"/);
  assert.match(skipRuleset, /shorted\.com\.au/);
  assert.match(skipRuleset, /www\.shorted\.com\.au/);
  assert.match(skipRuleset, /\/shorts\.v1alpha1\./);
  assert.match(skipRuleset, /\/marketdata\.v1\./);
  assert.match(skipRuleset, /\/chat\.v1\./);
  assert.match(skipRuleset, /\/api\/auth\//);
  assert.match(skipRuleset, /\/api\/market-data\//);
  assert.match(skipRuleset, /\/api\/community\//);

  assert.doesNotMatch(skipRuleset, /http_request_firewall_managed/);
  assert.doesNotMatch(skipRuleset, /"waf"/);
  assert.doesNotMatch(skipRuleset, /"rateLimit"/);
});

test("production Cloudflare import sweep covers the app API security skip ruleset", () => {
  assert.match(
    prodImportCloudflareSh,
    /module\.edge\.cloudflare_ruleset\.app_api_security_skip\[0\]/,
  );
  assert.match(
    prodImportCloudflareSh,
    /module\.edge\.cloudflare_ruleset\.response_header_transforms\[0\]/,
  );
});

test("production Cloudflare import sweep skips already-managed addresses without importing", () => {
  assert.match(
    prodImportCloudflareSh,
    /terraform state show -no-color "\$addr" >\/dev\/null 2>&1/,
  );
  assert.doesNotMatch(
    prodImportCloudflareSh,
    /terraform state list 2>\/dev\/null \| grep -Fxq "\$addr"/,
  );
});

test("production Cloudflare DNS imports use provider v5 zone and record IDs", () => {
  const dnsImports = prodImportCloudflareSh.match(
    /tf_import 'module\.edge\.cloudflare_dns_record\.[^']+'[^\n]+/g,
  ) ?? [];

  assert.equal(dnsImports.length, 3);

  for (const line of dnsImports) {
    assert.match(line, /"\$\{ZONE_ID\}\/[0-9a-f]{32}"/);
    assert.doesNotMatch(line, /zones\/\$\{ZONE_ID\}\/dns_records/);
  }
});

test("Cloudflare static asset cache rules do not cache non-2xx responses", () => {
  const cachedAssetRules = [
    "Cache Next.js static assets (JS/CSS/WASM) at edge",
    "Cache Next.js page data (RSC/JSON) at edge",
    "Cache static image assets at edge",
    "Cache static font assets at edge",
  ];

  for (const description of cachedAssetRules) {
    const rule = ruleBlockByDescription(description);

    assert.match(rule, /cache\s+=\s+true/);
    assert.match(rule, /edge_ttl\s+=\s+\{/);
    assert.match(rule, /mode\s+=\s+"override_origin"/);
    assert.match(rule, /default\s+=\s+31536000/);
    assert.match(rule, /from\s+=\s+200[\s\S]*to\s+=\s+299[\s\S]*value\s+=\s+31536000/);
    assert.match(rule, /from\s+=\s+300[\s\S]*value\s+=\s+0/);
    assert.match(rule, /browser_ttl\s+=\s+\{[\s\S]*mode\s+=\s+"respect_origin"/);
  }
});

test("Cloudflare strips immutable browser caching from missing Next.js assets", () => {
  assert.match(mainTf, /cloudflare_ruleset" "response_header_transforms"/);

  const transformIndex = mainTf.indexOf("Prevent browser caching of missing Next.js static assets");
  assert.ok(transformIndex > 0, "missing Next.js asset response transform should be present");

  const transformRuleStart = mainTf.lastIndexOf(
    'resource "cloudflare_ruleset" "response_header_transforms"',
    transformIndex,
  );
  const transformRule = mainTf.slice(transformRuleStart, mainTf.indexOf("# =============================================================================", transformIndex));
  assert.match(transformRule, /phase\s+=\s+"http_response_headers_transform"/);
  assert.match(transformRule, /http\.request\.uri\.path contains \\"\/_next\/static\/\\"/);
  assert.match(transformRule, /http\.response\.code ge 400/);
  assert.match(transformRule, /"Cache-Control"\s+=\s+\{/);
  assert.match(transformRule, /operation\s+=\s+"set"/);
  assert.match(transformRule, /value\s+=\s+"no-store, max-age=0, must-revalidate"/);
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
  assert.match(shortDataSyncPy, /"tag": "shorts-data,scan-results"/);
  assert.match(
    shortDataSyncPy,
    /"path": "\/,\/top,\/news,\/screener,\/industry,\/shorts\/\[stockCode\],\/statistics,\/scans"/,
  );
  assert.match(shortDataSyncPy, /"flush": "shorts"/);
});
