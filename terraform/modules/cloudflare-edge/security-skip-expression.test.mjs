// Regression coverage for the SBFM skip rule that keeps our PUBLISHED
// machine-readable surfaces fetchable by non-browser clients.
//
// Context (measured against prod 2026-08-27 with `-A 'my-app/1.0'`):
// `cloudflare_bot_management.ai_crawl_control` sets
// `sbfm_definitely_automated = "managed_challenge"`, so every non-verified
// automated client gets `403 / cf-mitigated: challenge` on any path SBFM does
// not consider a static resource. Cloudflare's static-resource bypass is
// extension-based (`.txt` yes, `.json`/`.yaml`/`.md`/`.xml` no) plus the
// `/.well-known/` path prefix — which is exactly why `/llms.txt`,
// `/robots.txt` and `/.well-known/*` returned 200 while `/openapi.json`,
// `/openapi.yaml` and `/docs/api.md` returned 403.
//
// The only supported way to carve exceptions out of SBFM is a WAF custom rule
// with the `skip` action, which is the rule asserted below. These tests parse
// the Terraform expression and EVALUATE it, so a path silently dropping out of
// the exemption fails here rather than in production.
//
// Run: node --test terraform/modules/cloudflare-edge/security-skip-expression.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const mainTf = readFileSync(new URL("./main.tf", import.meta.url), "utf8");

const SKIP_RULE_DESCRIPTION_PREFIX = "Allow non-verified feed readers";

/**
 * Pull the heredoc `expression` belonging to the rule whose description starts
 * with `descriptionPrefix`.
 */
function skipExpressionForDescription(descriptionPrefix) {
  const descriptionIndex = mainTf.indexOf(`description = "${descriptionPrefix}`);
  assert.ok(descriptionIndex > 0, `rule "${descriptionPrefix}…" should be present`);

  const expressionStart = mainTf.lastIndexOf("expression  = <<-EOT", descriptionIndex);
  assert.ok(
    expressionStart > 0 && expressionStart < descriptionIndex,
    "rule should carry a heredoc expression",
  );

  const bodyStart = mainTf.indexOf("\n", expressionStart) + 1;
  const bodyEnd = mainTf.indexOf("EOT", bodyStart);
  assert.ok(bodyEnd > bodyStart, "heredoc should terminate");

  return mainTf.slice(bodyStart, bodyEnd);
}

// ---------------------------------------------------------------------------
// A deliberately tiny evaluator for the Cloudflare rules-language subset used
// by this rule: parentheses, `and`/`or`, `<field> eq "<literal>"` and
// `starts_with(<field>, "<literal>")`. Anything outside that subset throws,
// so the test can never quietly "pass" on an expression it does not understand.
// ---------------------------------------------------------------------------

function tokenize(expression) {
  const tokens = [];
  const pattern =
    /\(|\)|,|\band\b|\bor\b|starts_with|\beq\b|"((?:[^"\\]|\\.)*)"|[A-Za-z_][A-Za-z0-9_.]*/g;
  let match;
  let consumed = 0;
  let cursor = 0;

  while ((match = pattern.exec(expression)) !== null) {
    // Everything skipped between matches must be whitespace — otherwise the
    // expression contains syntax this evaluator does not model.
    const gap = expression.slice(cursor, match.index);
    assert.equal(gap.trim(), "", `unsupported token near: ${gap.trim()}`);
    cursor = match.index + match[0].length;
    consumed += match[0].length;

    if (match[1] !== undefined) {
      tokens.push({ type: "string", value: match[1] });
    } else {
      tokens.push({ type: "symbol", value: match[0] });
    }
  }

  assert.equal(expression.slice(cursor).trim(), "", "trailing unsupported tokens");
  assert.ok(consumed > 0, "expression should not be empty");
  return tokens;
}

function parse(tokens) {
  let position = 0;

  const peek = () => tokens[position];
  const next = () => tokens[position++];
  const expect = (value) => {
    const token = next();
    assert.ok(token && token.value === value, `expected ${value}, got ${token?.value}`);
    return token;
  };

  function parsePrimary() {
    const token = peek();
    assert.ok(token, "unexpected end of expression");

    if (token.value === "(") {
      next();
      const inner = parseOr();
      expect(")");
      return inner;
    }

    if (token.value === "starts_with") {
      next();
      expect("(");
      const field = next();
      expect(",");
      const literal = next();
      expect(")");
      assert.equal(literal.type, "string", "starts_with needs a string literal");
      return (request) => String(readField(request, field.value)).startsWith(literal.value);
    }

    // `<field> eq "<literal>"`
    const field = next();
    assert.equal(field.type, "symbol", `expected a field, got ${field.value}`);
    expect("eq");
    const literal = next();
    assert.equal(literal.type, "string", "eq needs a string literal");
    return (request) => readField(request, field.value) === literal.value;
  }

  function parseAnd() {
    let left = parsePrimary();
    while (peek()?.value === "and") {
      next();
      const right = parsePrimary();
      const previous = left;
      left = (request) => previous(request) && right(request);
    }
    return left;
  }

  function parseOr() {
    let left = parseAnd();
    while (peek()?.value === "or") {
      next();
      const right = parseAnd();
      const previous = left;
      left = (request) => previous(request) || right(request);
    }
    return left;
  }

  const evaluate = parseOr();
  assert.equal(position, tokens.length, "unconsumed tokens in expression");
  return evaluate;
}

function readField(request, field) {
  switch (field) {
    case "http.host":
      return request.host;
    case "http.request.uri.path":
      return request.path;
    default:
      throw new Error(`unsupported field: ${field}`);
  }
}

function compile(expression) {
  return parse(tokenize(expression));
}

const skips = compile(skipExpressionForDescription(SKIP_RULE_DESCRIPTION_PREFIX));

const FRONTEND_HOSTS = ["shorted.com.au", "www.shorted.com.au"];

function skipsOnFrontend(path) {
  return FRONTEND_HOSTS.every((host) => skips({ host, path }));
}

// ---------------------------------------------------------------------------
// Positive cases — everything the discovery spine advertises to agents.
// ---------------------------------------------------------------------------

const EXEMPT_PATHS = [
  // Pre-existing coverage; regression-guarded so a rewrite cannot drop them.
  "/sitemap.xml",
  "/feed.xml",
  // The OpenAPI document, in both renditions. `Link: rel=service-desc` points
  // at /openapi.json, so a 403 here breaks RFC 9727 discovery outright.
  "/openapi.json",
  "/openapi.yaml",
  // The JS-free markdown API reference and the rest of the public docs tree.
  "/docs/api.md",
  "/docs/api",
  "/docs/api-reference",
  "/docs/llm-context",
  "/docs/llm-context-raw",
  "/docs/api/clients",
  // Well-known discovery documents. Cloudflare's static-resource bypass covers
  // /.well-known/ implicitly today; we name it so the contract is ours.
  "/.well-known/api-catalog",
  "/.well-known/ai-plugin.json",
  "/.well-known/mcp/server-card.json",
  // Documented public GET in the OpenAPI spec: filters a hardcoded in-memory
  // list, mutates nothing, and keeps its own app-layer rate limit.
  "/api/search/stocks",
];

for (const path of EXEMPT_PATHS) {
  test(`SBFM skip covers ${path} on both frontend hosts`, () => {
    assert.equal(
      skipsOnFrontend(path),
      true,
      `${path} is advertised to agents but would be managed-challenged`,
    );
  });
}

// ---------------------------------------------------------------------------
// Negative cases — the exemption must stay narrow. These are genuinely
// non-public or state-changing paths and must still face SBFM.
// ---------------------------------------------------------------------------

const STILL_CHALLENGED_PATHS = [
  "/admin/register/politicians", // operator console
  "/admin/jobs",
  "/api/stripe/webhook", // takes money
  "/api/admin/broadcast", // sends email
  "/api/user/api-keys", // mints credentials
  "/api/search/stocks/export", // not the documented endpoint
  "/docs", // only the /docs/ TREE is exempt, not a prefix match on "/docs…"
  "/docsecret", // guards against a `starts_with(…, "/docs")` slip
  "/.well-knownsomething", // guards against a missing trailing slash
  "/openapi.json.bak",
];

for (const path of STILL_CHALLENGED_PATHS) {
  test(`SBFM skip does NOT cover ${path}`, () => {
    for (const host of FRONTEND_HOSTS) {
      assert.equal(
        skips({ host, path }),
        false,
        `${path} must remain behind Super Bot Fight Mode`,
      );
    }
  });
}

test("SBFM skip is scoped to the frontend hosts only", () => {
  for (const path of EXEMPT_PATHS) {
    assert.equal(
      skips({ host: "api.shorted.com.au", path }),
      false,
      "the API host has its own skip rule; this one must not widen it",
    );
    assert.equal(skips({ host: "evil.example.com", path }), false);
  }
});

test("the skip only drops bot/security checks, never WAF or rate limiting", () => {
  const descriptionIndex = mainTf.indexOf(
    `description = "${SKIP_RULE_DESCRIPTION_PREFIX}`,
  );
  const ruleEnd = mainTf.indexOf("\n    },", descriptionIndex);
  const actionParameters = mainTf.slice(descriptionIndex, ruleEnd);

  assert.match(actionParameters, /phases\s+=\s+\["http_request_sbfm"\]/);
  assert.match(actionParameters, /products\s+=\s+\["bic",\s*"securityLevel"\]/);
  assert.doesNotMatch(
    actionParameters,
    /http_ratelimit/,
    "the documentation exemption must never skip rate limiting",
  );
  assert.doesNotMatch(
    actionParameters,
    /http_request_firewall_managed/,
    "the documentation exemption must never skip managed WAF rules",
  );
});

test("Super Bot Fight Mode remains the thing being skipped, not disabled", () => {
  // If any of these drift, the exemption above is solving the wrong problem.
  assert.match(mainTf, /sbfm_definitely_automated\s+=\s+"managed_challenge"/);
  assert.match(mainTf, /sbfm_verified_bots\s+=\s+"allow"/);
  assert.match(mainTf, /sbfm_static_resource_protection\s+=\s+false/);
});
