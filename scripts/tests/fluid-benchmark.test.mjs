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

test("bounded run uses GET only, limits concurrent requests and never records protection credentials", async () => {
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
      return new Response(route === "/api/version" ? JSON.stringify({ nodeVersion: "v24.8.0", gitCommit: "fixture", environment: "preview" }) : `<html>${route} ${"content ".repeat(30)}</html>`, {
        headers: { "content-type": route === "/api/version" ? "application/json" : "text/html", "x-vercel-cache": "MISS" },
      });
    },
  });
  assert.equal(report.passed, true);
  assert.equal(requests.length, ROUTES.length * (1 + 2 * 5));
  assert.equal(peak, 4);
  assert.ok(requests.every(({ url, method }) => method === "GET" && ROUTES.includes(new URL(url).pathname)));
  assert.equal(JSON.stringify(report).includes(secret), false);
});

test("protection redirects and incorrect stock content fail verification", async () => {
  const report = await runBenchmark([{ label: "candidate", url: "https://shorted-test.vercel.app" }], {
    requests: 1,
    fetchImpl: async (url) => new URL(url).pathname === "/api/version"
      ? new Response("", { status: 302 })
      : new Response(`<html>${"wrong stock ".repeat(20)}</html>`, { headers: { "content-type": "text/html" } }),
  });
  assert.equal(report.passed, false);
  assert.equal(report.deployments[0].blocked, true);
  assert.equal(report.deployments[0].results.length, 0);
  assert.equal(report.deployments[0].warmups.find(({ route }) => route === "/shorts/BHP").contentValid, false);
  assert.equal(report.deployments[0].warmups.find(({ route }) => route === "/api/version").status, 302);
});
