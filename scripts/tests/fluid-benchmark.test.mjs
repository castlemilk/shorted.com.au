import assert from "node:assert/strict";
import test from "node:test";
import { ROUTES, boundedInteger, percentile, runBenchmark, validateDeploymentUrl } from "../benchmark-fluid-preview.mjs";

test("targets explicit Shorted deployment origins and rejects credentials, production domains and query strings", () => {
  assert.equal(validateDeploymentUrl("https://shorted-abc123-document-analyser.vercel.app"), "https://shorted-abc123-document-analyser.vercel.app");
  for (const url of ["https://shorted.com.au", "https://shorted.vercel.app", "https://example.com", "https://secret@shorted-abc.vercel.app", "https://shorted-abc.vercel.app/?token=secret", "https://shorted-abc.vercel.app/api/version"]) {
    assert.throws(() => validateDeploymentUrl(url));
  }
  assert.throws(() => boundedInteger(13, "requests", 1, 12));
  assert.throws(() => boundedInteger(1.5, "requests", 1, 12));
  assert.equal(percentile([5, 1, 3, 2, 4], 0.95), 5);
});

test("bounded run exercises dynamic statistics with unique CDN keys, limits concurrency and never records credentials", async () => {
  let active = 0;
  let peak = 0;
  const requests = [];
  const secret = "fixture-protection-secret";
  const report = await runBenchmark([{ label: "candidate", url: "https://shorted-test.vercel.app" }], {
    requests: 5,
    bypassSecret: secret,
    fetchImpl: async (url, options) => {
      requests.push({ url, method: options.method });
      assert.equal(options.redirect, "manual");
      assert.equal(options.headers["x-vercel-protection-bypass"], secret);
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      const route = new URL(url).pathname;
      return new Response(route === "/api/about/statistics" ? JSON.stringify({ companyCount: 100, industryCount: 20, latestUpdateDate: "2026-10-02T00:00:00.000Z" }) : `<html>${route} ${"content ".repeat(30)}</html>`, {
        headers: { "content-type": route === "/api/about/statistics" ? "application/json" : "text/html", "x-vercel-cache": "MISS", "x-cache": "HIT" },
      });
    },
  });
  assert.equal(report.passed, true);
  assert.equal(requests.length, ROUTES.length * (1 + 2 * 5));
  assert.equal(peak, 4);
  assert.ok(requests.every(({ url, method }) => method === "GET" && ROUTES.includes(new URL(url).pathname)));
  const statisticsUrls = requests.map(({ url }) => new URL(url)).filter(({ pathname }) => pathname === "/api/about/statistics");
  assert.equal(new Set(statisticsUrls.map(({ search }) => search)).size, statisticsUrls.length);
  assert.ok(statisticsUrls.every(({ searchParams }) => searchParams.get("fluid_probe")));
  assert.ok(requests.every(({ url }) => new URL(url).pathname === "/api/about/statistics" || !new URL(url).search));
  const statisticsResults = report.deployments[0].results.filter(({ route }) => route === "/api/about/statistics");
  assert.ok(statisticsResults.every(({ samples }) => samples.every(({ invocationVerified, applicationCache }) => invocationVerified && applicationCache === "HIT")));
  assert.equal(JSON.stringify(report).includes(secret), false);
});

test("static version JSON, invalid statistics and CDN hits cannot validate the Node control", async () => {
  for (const fixture of [
    { body: { nodeVersion: "v24.8.0", gitCommit: "fixture" }, cache: "MISS", contentValid: false },
    { body: { companyCount: 0, industryCount: 0, latestUpdateDate: null }, cache: "MISS", contentValid: false },
    { body: { companyCount: 100, industryCount: 20, latestUpdateDate: null }, cache: "HIT", contentValid: true },
  ]) {
    const report = await runBenchmark([{ label: "candidate", url: "https://shorted-test.vercel.app" }], {
      requests: 1,
      fetchImpl: async (url) => new URL(url).pathname === "/api/about/statistics"
        ? new Response(JSON.stringify(fixture.body), { headers: { "content-type": "application/json", "x-vercel-cache": fixture.cache } })
        : new Response(`<html>${new URL(url).pathname} ${"content ".repeat(30)}</html>`, { headers: { "content-type": "text/html" } }),
    });
    assert.equal(report.passed, false);
    assert.equal(report.deployments[0].warmups[0].contentValid, fixture.contentValid);
  }
});

test("protection redirects and incorrect stock content fail verification", async () => {
  const report = await runBenchmark([{ label: "candidate", url: "https://shorted-test.vercel.app" }], {
    requests: 1,
    fetchImpl: async (url) => new URL(url).pathname === "/api/about/statistics"
      ? new Response("", { status: 302 })
      : new Response(`<html>${"wrong stock ".repeat(20)}</html>`, { headers: { "content-type": "text/html" } }),
  });
  assert.equal(report.passed, false);
  assert.equal(report.deployments[0].blocked, true);
  assert.equal(report.deployments[0].results.length, 0);
  assert.equal(report.deployments[0].warmups.find(({ route }) => route === "/shorts/BHP").contentValid, false);
  assert.equal(report.deployments[0].warmups.find(({ route }) => route === "/api/about/statistics").status, 302);
});
