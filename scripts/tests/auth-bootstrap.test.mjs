import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { checkFirebaseGoogleAuthBootstrap } from "../../web/e2e/helpers/firebase-google-auth-bootstrap.mjs";
import { classifyAuthEndpoint, inspectAuthConsole, recordAuthNetwork } from "../../web/e2e/helpers/auth-bootstrap-diagnostics.mjs";

const origin = "https://shorted-fixture.vercel.app";
const key = "fixture-api-key-private";
const privateQuery = `apiKey=${key}&email=private@example.com&state=private-oauth-state&token=private-token`;
function fixture(onClick) {
  const context = new EventEmitter();
  const page = new EventEmitter();
  context.closed = false;
  context.close = async () => { context.closed = true; };
  context.newPage = async () => page;
  context.routes = [];
  context.route = async (pattern, handler) => { context.routes.push({ pattern, handler }); };
  page.goto = async () => page.emit("console", { text: () => "Firebase initialized successfully" });
  page.getByRole = () => ({ click: async () => onClick(context, page) });
  return { browser: { newContext: async (options) => { context.options = options; return context; } }, context };
}
function request(context, url) { context.emit("request", { url: () => url }); }
function response(context, url, status = 200, body = {}, headers = {}) {
  context.emit("response", { url: () => url, status: () => status, headers: () => headers, json: async () => body });
}
function configResponses(context) {
  response(context, `https://identitytoolkit.googleapis.com/v1/projects?key=${key}`);
  response(context, `https://www.googleapis.com/identitytoolkit/v3/relyingparty/getProjectConfig?key=${key}`);
}
const noNetwork = async () => { throw new Error("unexpected external request in offline test"); };
function failureResult(error) { return JSON.parse(error.message.match(/: (\{[^\n]*\})/)[1]); }

test("zero observed keys performs no probe and reports sanitized helper challenge/CSP/SDK evidence", async () => {
  let probes = 0;
  const zero = fixture((context, page) => {
    response(context, "https://shorted.com.au/__/auth/iframe?state=private-oauth-state", 403, {}, { "cf-mitigated": "challenge" });
    page.emit("console", { text: () => `Content Security Policy frame-src; auth/unauthorized-domain private@example.com ${key}` });
  });
  await assert.rejects(checkFirebaseGoogleAuthBootstrap({ browser: zero.browser, baseUrl: origin, timeoutMs: 1, fetchImpl: async () => { probes++; } }), (error) => {
    const result = failureResult(error);
    assert.equal(result.identityToolkitOk, 0);
    assert.equal(result.authUriProbeAttempts, 0);
    assert.equal(result.authUriProbeSkipped, "no_observed_key");
    assert.equal(result.cspPolicyError, true);
    assert.deepEqual(result.sdkErrorCodes, ["auth/unauthorized-domain"]);
    assert.deepEqual(result.authNetwork, [{ surface: "production_auth_proxy", endpoint: "/__/auth/iframe", status: 403, challenge: true }]);
    for (const value of [key, "private@example.com", "private-oauth-state"]) assert.ok(!error.message.includes(value));
    return true;
  });
  assert.equal(probes, 0);
  assert.equal(zero.context.closed, true);
});

test("custom same-origin helper keys enable a bounded fallback while preserving config assertions", async () => {
  const { browser } = fixture((context) => {
    request(context, `${origin}/__/auth/iframe?${privateQuery}`);
    configResponses(context);
  });
  const result = await checkFirebaseGoogleAuthBootstrap({ browser, baseUrl: origin, timeoutMs: 1, fetchImpl: async (url, options) => {
    assert.equal(new URL(url).searchParams.get("key"), key);
    assert.equal(options.method, "POST");
    assert.equal(options.signal.aborted, false);
    assert.equal(JSON.parse(options.body).continueUri, `${origin}/signin`);
    return { status: 200, ok: true, json: async () => ({ authUri: "https://accounts.google.com/fixture" }) };
  } });
  assert.equal(result.identityToolkitOk, 2);
  assert.equal(result.authUriProbeAttempts, 1);
  assert.equal(result.authUriProbeOk, true);
  assert.match(result.apiKeyHashes[0], /^[a-f0-9]{12}$/);
  assert.ok(!JSON.stringify(result).includes(key));
});

test("OAuth navigation waits for later config responses before closing the context", async () => {
  const { browser, context } = fixture((context) => {
    request(context, "https://accounts.google.com/o/oauth2/auth?state=private-oauth-state");
    setTimeout(() => { if (!context.closed) configResponses(context); }, 20);
  });
  const result = await checkFirebaseGoogleAuthBootstrap({ browser, baseUrl: origin, timeoutMs: 650, fetchImpl: noNetwork });
  assert.equal(result.googleOAuthSeen, true);
  assert.equal(result.identityToolkitOk, 2);
  assert.equal(context.closed, true);
});

test("OAuth navigation alone cannot satisfy the config-response contract", async () => {
  const { browser } = fixture((context) => request(context, "https://accounts.google.com/o/oauth2/auth"));
  await assert.rejects(checkFirebaseGoogleAuthBootstrap({ browser, baseUrl: origin, timeoutMs: 1, fetchImpl: noNetwork }), /Identity Toolkit did not return enough/);
});

test("invalid keys and malicious endpoint lookalikes cannot satisfy auth assertions", async () => {
  const { browser } = fixture((context) => {
    response(context, "https://identitytoolkit.googleapis.com.attacker.test/v1/projects", 200);
    response(context, "https://attacker.test/?url=identitytoolkit.googleapis.com&createAuthUri", 200);
    request(context, "https://attacker.test/?url=accounts.google.com/o/oauth2/auth");
    response(context, `https://identitytoolkit.googleapis.com/v1/projects?key=${key}`, 400, { error: { details: [{ reason: "API_KEY_INVALID" }] } });
  });
  await assert.rejects(checkFirebaseGoogleAuthBootstrap({ browser, baseUrl: origin, timeoutMs: 1, fetchImpl: noNetwork }), (error) => {
    const result = failureResult(error);
    assert.equal(result.identityToolkitOk, 0);
    assert.equal(result.googleOAuthSeen, false);
    assert.equal(result.authUriCreated, false);
    assert.match(error.message, /Google rejected Firebase API key/);
    return true;
  });
});

test("diagnostics redact arbitrary strings, deduplicate and bound network entries", () => {
  const summary = { cspPolicyError: false, sdkErrorCodes: [], authNetwork: [] };
  assert.equal(classifyAuthEndpoint(`https://shorted.com.au.attacker.test/__/auth/iframe?${privateQuery}`, origin), null);
  assert.equal(classifyAuthEndpoint(`https://attacker.test/__/auth/iframe?${privateQuery}`, origin), null);
  const endpoint = classifyAuthEndpoint(`${origin}/__/auth/iframe?${privateQuery}`, origin);
  for (let i = 0; i < 20; i++) recordAuthNetwork(summary, endpoint, { status: 400 + i, errorText: privateQuery });
  inspectAuthConsole(`auth/custom-${privateQuery}`, summary);
  assert.equal(summary.authNetwork.length, 8);
  assert.deepEqual(summary.sdkErrorCodes, []);
  assert.ok(summary.authNetwork.every((entry) => entry.error === "NETWORK_ERROR"));
  for (const value of [key, "private@example.com", "private-oauth-state", "private-token"]) assert.ok(!JSON.stringify(summary).includes(value));
});

test("testing bypass remains scoped only to the app origin", async () => {
  const { browser, context } = fixture((context) => {
    configResponses(context);
    request(context, "https://accounts.google.com/o/oauth2/auth");
  });
  await checkFirebaseGoogleAuthBootstrap({ browser, baseUrl: origin, bypassSecret: "fixture-bypass-secret", timeoutMs: 650, fetchImpl: noNetwork });
  const bypass = context.routes.find(({ pattern }) => pattern instanceof RegExp);
  assert.ok(bypass.pattern.test(`${origin}/signin`));
  for (const url of ["https://accounts.google.com/o/oauth2/auth", "https://shorted.com.au/__/auth/iframe", `${origin}.attacker.test/signin`]) assert.equal(bypass.pattern.test(url), false);
  let forwarded;
  await bypass.handler({ request: () => ({ headers: () => ({ "content-type": "application/json" }) }), continue: async (options) => { forwarded = options.headers; } });
  assert.deepEqual(forwarded, { "content-type": "application/json", "x-shorted-testing-bypass": "fixture-bypass-secret" });
  const analytics = context.routes.find(({ pattern }) => typeof pattern === "function");
  assert.equal(analytics.pattern(new URL("https://www.google-analytics.com/g/collect")), true);
  assert.equal(analytics.pattern(new URL("https://accounts.google.com/o/oauth2/auth")), false);
  assert.equal(context.options.serviceWorkers, "block");
});
