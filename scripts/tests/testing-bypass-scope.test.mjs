import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isTestingBypassOrigin,
  routeTestingBypass,
  scopeTestingBypassRequests,
} from "../../web/e2e/helpers/testing-bypass-scope.mjs";

const bypass = { "X-Shorted-Testing-Bypass": "inert-fixture-value" };

test("our own origins and this machine may receive the trusted-test header", () => {
  for (const url of [
    "http://localhost:3020/shorts/BHP",
    "http://127.0.0.1:9091/health",
    "http://[::1]:3020/",
    "https://localhost:3001/",
    "https://shorted.com.au/",
    "https://www.shorted.com.au/top",
    "https://api.shorted.com.au/shorts.v1alpha1.StockService/GetStock",
    "https://shorted-com-hfod9ow29-document-analyser.vercel.app/",
  ]) {
    assert.equal(isTestingBypassOrigin(url), true, url);
  }
});

test("third parties and lookalikes never receive it", () => {
  for (const url of [
    "https://www.google-analytics.com/g/collect",
    "https://www.googletagmanager.com/gtag/js",
    "https://storage.googleapis.com/shorted-company-logos/BHP.png",
    "https://static.cloudflareinsights.com/beacon.min.js",
    "https://identitytoolkit.googleapis.com/v1/accounts",
    "https://shorted.com.au.evil.example/",
    "https://shorted.com.au@evil.example/",
    "https://evil.example/?u=https://shorted.com.au",
    "http://api.shorted.com.au/",
    "https://api.shorted.com.au:444/",
    "https://localhost.evil.example/",
    "data:text/plain,hello",
    "not a url",
  ]) {
    assert.equal(isTestingBypassOrigin(url), false, url);
  }
});

test("a browser context adds the header to our own requests only, and keeps their headers", async () => {
  let matcher;
  let handler;
  await routeTestingBypass({ route: async (m, h) => { matcher = m; handler = h; } }, bypass);
  assert.equal(matcher(new URL("https://www.google.com/recaptcha")), false);
  assert.equal(matcher(new URL("http://localhost:3020/shorts/BHP")), true);
  let fallback;
  await handler({
    request: () => ({
      url: () => "http://localhost:3020/shorts/BHP",
      headers: () => ({ accept: "text/html", "user-agent": "fixture" }),
    }),
    fallback: async (options) => { fallback = options; },
  });
  assert.deepEqual(fallback, { headers: { accept: "text/html", "user-agent": "fixture", ...bypass } });
});

test("without a secret no route is installed", async () => {
  let routed = false;
  await routeTestingBypass({ route: async () => { routed = true; } }, {});
  assert.equal(routed, false);
});

test("an API request context sends the header to our own URLs only", async () => {
  const calls = [];
  const request = {
    get: async (url, options) => { calls.push(["get", url, options]); return "response"; },
    post: async (url, options) => { calls.push(["post", url, options]); },
    dispose: async () => "disposed",
  };
  const scoped = scopeTestingBypassRequests(request, "http://localhost:3020", bypass);

  assert.equal(await scoped.get("/api/health"), "response");
  await scoped.post("https://api.shorted.com.au/x", { data: { a: 1 }, headers: { "content-type": "application/json" } });
  await scoped.get("https://www.google.com/");
  assert.equal(await scoped.dispose(), "disposed");

  assert.deepEqual(calls, [
    ["get", "/api/health", { headers: bypass }],
    ["post", "https://api.shorted.com.au/x", { data: { a: 1 }, headers: { ...bypass, "content-type": "application/json" } }],
    ["get", "https://www.google.com/", {}],
  ]);
});

test("an API request context against a base URL that is not ours sends nothing", async () => {
  const calls = [];
  const scoped = scopeTestingBypassRequests(
    { get: async (url, options) => { calls.push(options); } },
    "https://evil.example",
    bypass,
  );
  await scoped.get("/robots.txt");
  assert.deepEqual(calls, [{}]);
});
