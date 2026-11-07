/**
 * The crawler policy at the edge must say what robots.txt says.
 *
 * Two rules, both Terraform-owned:
 *   - a Single Redirect that sends the steered crawlers (Baidu, the SEO and
 *     training scrapers, the two AI agents measured misbehaving) to the
 *     data-licence page before they reach the origin;
 *   - a rate limit on verified AI crawlers and AI search bots on the HTML host.
 *
 * The steered list lives in web/src/app/robots.txt/route.ts; the variable's
 * default here must equal it, so a crawler robots.txt steers is also steered
 * at the edge, and one the edge steers is told so in robots.txt.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const mainTf = readFileSync(new URL("./main.tf", import.meta.url), "utf8");
const variablesTf = readFileSync(new URL("./variables.tf", import.meta.url), "utf8");
const robotsRoute = readFileSync(
  new URL("../../../web/src/@/lib/seo/crawl-policy.ts", import.meta.url),
  "utf8",
);

function tfListDefault(variable) {
  const block = variablesTf.match(new RegExp(`variable "${variable}" \\{([\\s\\S]*?)\\n\\}`));
  assert.ok(block, `variable "${variable}" is declared`);
  const def = block[1].match(/default\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(def, `variable "${variable}" has a list default`);
  return [...def[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

function tsListConst(name) {
  const m = robotsRoute.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\];`));
  assert.ok(m, `${name} is exported from the robots route`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

test("the edge steers exactly the crawlers robots.txt steers", () => {
  assert.deepEqual(tfListDefault("crawler_redirect_user_agents"), tsListConst("STEERED_CRAWLERS"));
});

test("the redirect target is the robots route's data-licence path", () => {
  const path = robotsRoute.match(/export const DATA_LICENCE_PATH = "([^"]+)"/)?.[1];
  assert.ok(path, "DATA_LICENCE_PATH is exported");
  const target = variablesTf.match(/variable "crawler_redirect_target"[\s\S]*?default\s*=\s*"([^"]+)"/)?.[1];
  assert.equal(target, `https://shorted.com.au${path}`);
});

test("the redirect rule is a zone Single Redirect that leaves robots.txt and the licence page alone", () => {
  const block = mainTf.match(/resource "cloudflare_ruleset" "crawler_redirects" \{[\s\S]*?\n\}/)?.[0];
  assert.ok(block, "crawler_redirects ruleset exists");
  assert.match(block, /phase\s*=\s*"http_request_dynamic_redirect"/);
  assert.match(block, /action\s*=\s*"redirect"/);
  assert.match(block, /status_code\s*=\s*302/);
  assert.match(block, /preserve_query_string\s*=\s*false/);
  const expr = mainTf.match(/crawler_redirect_expression = <<-EOT([\s\S]*?)EOT/)?.[1];
  assert.ok(expr, "the expression is a local");
  assert.match(expr, /http\.request\.uri\.path eq "\/robots\.txt"/);
  assert.match(expr, /http\.request\.uri\.path eq "\$\{local\.crawler_redirect_target_path\}"/);
  assert.match(expr, /starts_with\(http\.request\.uri\.path, "\/_next\/static\/"\)/);
  // The user agents are matched on the HTML host only: api.shorted.com.au is
  // keyed and metered by the API's own rules.
  assert.match(expr, /http\.host eq "shorted\.com\.au"/);
  assert.doesNotMatch(expr, /api\.shorted\.com\.au/);
});

test("verified AI crawlers are rate limited on the HTML host, AI assistants are not", () => {
  const expr = mainTf.match(/ai_crawler_rate_limit_expression = <<-EOT([\s\S]*?)EOT/)?.[1];
  assert.ok(expr, "the expression is a local");
  assert.match(expr, /cf\.verified_bot_category eq "AI Crawler"/);
  assert.match(expr, /cf\.verified_bot_category eq "AI Search"/);
  // ChatGPT-User, Claude-User and Perplexity-User fetch on a reader's behalf.
  assert.doesNotMatch(expr, /AI Assistant/);
  assert.doesNotMatch(expr, /api\.shorted\.com\.au/);
  const rule = mainTf.match(/description = "Rate limit — verified AI crawlers"[\s\S]*?ratelimit = \{[\s\S]*?\}/)?.[0];
  assert.ok(rule, "the rule sits in the rate limit ruleset");
  assert.match(rule, /characteristics\s*=\s*\["ip\.src", "cf\.colo\.id"\]/);
  assert.match(rule, /period\s*=\s*var\.ai_crawler_rate_limit_period/);
  assert.match(rule, /requests_per_period\s*=\s*var\.ai_crawler_rate_limit_requests/);
});

test("the Pro plan's period and timeout constraints are declared on the variables", () => {
  const period = variablesTf.match(/variable "ai_crawler_rate_limit_period" \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(period);
  assert.match(period, /contains\(\[10, 60\], var\.ai_crawler_rate_limit_period\)/);
  assert.match(period, /default\s*=\s*60/);
});
