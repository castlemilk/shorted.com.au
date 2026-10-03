#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

export const ROUTES = ["/api/version", "/top", "/shorts/BHP", "/shorts/CBA"];
const CONCURRENCY_LEVELS = [1, 4];

export function validateDeploymentUrl(value, { allowLocalhost = false } = {}) {
  const url = new URL(value);
  const local = allowLocalhost && ["localhost", "127.0.0.1"].includes(url.hostname);
  const preview = url.protocol === "https:" && /^shorted-[a-z0-9-]+\.vercel\.app$/.test(url.hostname);
  if ((!local && !preview) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Use an explicit Shorted deployment URL, without credentials, a path, or query parameters.");
  }
  return url.origin;
}

export function boundedInteger(value, name, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }
  return parsed;
}

export function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.ceil(sorted.length * fraction) - 1].toFixed(2));
}

async function request(origin, route, { timeoutMs, deadlineSignal, bypassSecret, fetchImpl }) {
  const start = performance.now();
  try {
    const response = await fetchImpl(`${origin}${route}`, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), deadlineSignal]),
      headers: {
        "User-Agent": "Shorted-Fluid-Preview-Benchmark/1.0",
        ...(bypassSecret ? { "x-vercel-protection-bypass": bypassSecret } : {}),
      },
    });
    const ttfbMs = performance.now() - start;
    const body = await response.text();
    const contentType = response.headers.get("content-type") ?? "";
    let contentValid = response.status === 200;
    let version;
    if (route === "/api/version") {
      try {
        const data = JSON.parse(body);
        contentValid &&= typeof data.nodeVersion === "string" && typeof data.gitCommit === "string";
        version = { gitCommit: data.gitCommit, environment: data.environment, nodeVersion: data.nodeVersion };
      } catch {
        contentValid = false;
      }
    } else {
      contentValid &&= contentType.includes("text/html") && body.length > 128;
      contentValid &&= !body.includes("Application error: a server-side exception");
      if (route.startsWith("/shorts/")) contentValid &&= body.includes(route.split("/").at(-1));
    }
    return {
      route, status: response.status, contentValid,
      ttfbMs: Number(ttfbMs.toFixed(2)),
      totalMs: Number((performance.now() - start).toFixed(2)),
      bytes: Buffer.byteLength(body), contentType,
      cache: response.headers.get("x-vercel-cache") ?? "UNKNOWN",
      vercelId: response.headers.get("x-vercel-id"),
      ...(version ? { version } : {}),
    };
  } catch (error) {
    return { route, status: 0, contentValid: false, totalMs: Number((performance.now() - start).toFixed(2)), error: error.name };
  }
}

async function batch(origin, route, count, concurrency, options) {
  const results = new Array(count);
  let next = 0;
  const start = performance.now();
  await Promise.all(Array.from({ length: Math.min(count, concurrency) }, async () => {
    while (next < count) {
      const index = next++;
      results[index] = await request(origin, route, options);
    }
  }));
  const elapsedMs = performance.now() - start;
  const successful = results.filter((result) => result.contentValid);
  const cacheCounts = {};
  for (const result of results) {
    const cache = result.cache ?? "ERROR";
    cacheCounts[cache] = (cacheCounts[cache] ?? 0) + 1;
  }
  return {
    route, concurrency, requests: count, successes: successful.length,
    elapsedMs: Number(elapsedMs.toFixed(2)),
    requestsPerSecond: Number((count * 1000 / elapsedMs).toFixed(2)),
    ttfbP50Ms: percentile(successful.map((result) => result.ttfbMs), 0.5),
    ttfbP95Ms: percentile(successful.map((result) => result.ttfbMs), 0.95),
    totalP95Ms: percentile(successful.map((result) => result.totalMs), 0.95),
    cacheCounts, samples: results,
  };
}

export async function runBenchmark(deployments, {
  requests = 6, timeoutMs = 20_000, bypassSecret,
  fetchImpl = fetch, allowLocalhost = false,
} = {}) {
  boundedInteger(requests, "requests", 1, 12);
  boundedInteger(timeoutMs, "timeout-ms", 100, 30_000);
  if (!deployments.length || deployments.length > 2) throw new Error("Benchmark one or two deployments.");
  const targets = deployments.map(({ label, url }) => ({ label, origin: validateDeploymentUrl(url, { allowLocalhost }) }));
  const report = { startedAt: new Date().toISOString(), requestsPerRoute: requests, concurrencyLevels: CONCURRENCY_LEVELS, routes: ROUTES, deployments: [] };
  const options = { timeoutMs, deadlineSignal: AbortSignal.timeout(180_000), bypassSecret, fetchImpl };
  for (const target of targets) {
    const warmups = [];
    for (const route of ROUTES) warmups.push(await request(target.origin, route, options));
    report.deployments.push({ ...target, warmups, blocked: warmups.some((sample) => !sample.contentValid), results: [] });
  }
  // Interleave baseline/candidate phases to reduce time-of-run differences.
  for (const concurrency of CONCURRENCY_LEVELS) {
    for (const route of ROUTES) {
      for (const target of report.deployments) {
        if (target.blocked) continue;
        target.results.push(await batch(target.origin, route, requests, concurrency, options));
      }
    }
  }
  report.finishedAt = new Date().toISOString();
  report.passed = report.deployments.every((deployment) =>
    deployment.warmups.every((sample) => sample.contentValid) &&
    deployment.results.every((result) => result.successes === result.requests));
  return report;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("Usage: node scripts/benchmark-fluid-preview.mjs --candidate https://shorted-DEPLOYMENT.vercel.app [--baseline URL] [--requests 6] [--timeout-ms 20000] [--output report.json]");
    console.log("Only public GET routes are requested. An existing VERCEL_AUTOMATION_BYPASS_SECRET may be supplied by the execution environment; it is never recorded.");
    return;
  }
  const values = {};
  const allowed = new Set(["--candidate", "--baseline", "--requests", "--timeout-ms", "--output"]);
  for (let index = 0; index < args.length; index += 2) {
    if (!allowed.has(args[index]) || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error("Invalid option. Use --help.");
    values[args[index]] = args[index + 1];
  }
  if (!values["--candidate"]) throw new Error("--candidate is required.");
  const deployments = [
    ...(values["--baseline"] ? [{ label: "baseline", url: values["--baseline"] }] : []),
    { label: "candidate", url: values["--candidate"] },
  ];
  const report = await runBenchmark(deployments, {
    requests: boundedInteger(values["--requests"] ?? 6, "requests", 1, 12),
    timeoutMs: boundedInteger(values["--timeout-ms"] ?? 20_000, "timeout-ms", 100, 30_000),
    bypassSecret: process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
  });
  if (values["--output"]) await writeFile(values["--output"], `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  for (const deployment of report.deployments) {
    console.log(`${deployment.label}: ${deployment.origin}`);
    if (deployment.blocked) {
      console.log("Initial verification failed; measured requests were skipped.");
      console.table(deployment.warmups.map(({ route, status, contentValid, error }) => ({ route, status, contentValid, error })));
      continue;
    }
    console.table(deployment.results.map(({ route, concurrency, successes, requests, ttfbP50Ms, ttfbP95Ms, cacheCounts }) => ({ route, concurrency, successes: `${successes}/${requests}`, ttfbP50Ms, ttfbP95Ms, cache: JSON.stringify(cacheCounts) })));
  }
  console.log("HTTP timing does not measure Active CPU, memory billing, or prove same-instance concurrency. Compare deployment-scoped Observability for the recorded window.");
  if (!report.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
