import assert from "node:assert/strict";
import { test } from "node:test";
import { isBrowserAnalyticsRequest, isolateBrowserAnalytics } from "../../web/e2e/helpers/browser-analytics-isolation.mjs";

const origin = "https://shorted.com.au";

test("release collectors are intercepted across regional GA and same-origin RUM endpoints", () => {
  for (const url of [
    "https://www.googletagmanager.com/gtag/js?id=fixture",
    "https://region1.google-analytics.com/g/collect?fixture=1",
    "https://stats.g.doubleclick.net/g/collect",
    "https://static.cloudflareinsights.com/beacon.min.js",
    "https://cloudflareinsights.com/cdn-cgi/rum",
    `${origin}/cdn-cgi/rum`,
    `${origin}/_vercel/insights/view`,
    `${origin}/_vercel/speed-insights/vitals`,
  ]) assert.equal(isBrowserAnalyticsRequest(new URL(url), origin), true, url);
});

test("authentication, challenges, app data and lookalike hosts keep their normal requests", () => {
  for (const url of [
    "https://accounts.google.com/o/oauth2/auth",
    "https://identitytoolkit.googleapis.com/v1/accounts:createAuthUri",
    `${origin}/__/auth/iframe`,
    `${origin}/cdn-cgi/challenge-platform/script.js`,
    `${origin}/api/market-data/multiple-quotes`,
    "https://api.shorted.com.au/shorts.v1alpha1.ShortedStocksService/GetTopShorts",
    "https://google-analytics.com.example.com/g/collect",
    "https://other.example.com/cdn-cgi/rum",
  ]) assert.equal(isBrowserAnalyticsRequest(new URL(url), origin), false, url);
});

test("a matched browser route is fulfilled locally without forwarding any headers or body", async () => {
  const calls = [];
  await isolateBrowserAnalytics({ route: async (matches, handle) => {
    assert.equal(matches(new URL(`${origin}/cdn-cgi/rum?fixture=1`)), true);
    assert.equal(matches(new URL(`${origin}/signin`)), false);
    await handle({
      fulfill: async (response) => calls.push(response),
      continue: () => assert.fail("collector request was forwarded"),
    });
  } }, `${origin}/signin`);
  assert.deepEqual(calls, [{ status: 204, body: "" }]);
});
