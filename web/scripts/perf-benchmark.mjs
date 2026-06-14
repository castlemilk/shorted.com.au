#!/usr/bin/env node
// Playwright-driven performance benchmark for the Shorted dashboard.
//
// Measures TTFB / FCP / LCP / CLS / DCL / load / transfer / requests and any
// `widget:*` performance marks across the homepage and the custom dashboard.
//
// Usage:
//   node scripts/perf-benchmark.mjs [--url <base>] [--runs <n>] [--out <path>] [--compare <baseline.json>]
//
// Notes:
//   - Run against a PRODUCTION build (`npm run build && npm run start`), on a quiet machine.
//   - LCP and layout-shift are buffered-only entries: we install PerformanceObservers
//     via addInitScript BEFORE goto, stashing latest LCP + cumulative CLS on window.__perf.
//   - This script runs from web/, but the committed baseline lives at ../docs/perf/.

import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

// ---------------------------------------------------------------------------
// argv parsing (intentionally simple)
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { url: "http://localhost:3020", runs: 5, out: null, compare: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") args.url = argv[++i];
    else if (a === "--runs") args.runs = parseInt(argv[++i], 10);
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--compare") args.compare = argv[++i];
    else console.warn(`[perf] ignoring unknown arg: ${a}`);
  }
  if (!Number.isFinite(args.runs) || args.runs < 1) args.runs = 5;
  return args;
}

const PAGES = ["/", "/dashboards"];
const SETTLE_MS = 4000; // let LCP/CLS settle + hydration finish

// Metrics where "bigger is worse" (used for regression flagging).
const LOWER_IS_BETTER = new Set([
  "ttfb",
  "fcp",
  "lcp",
  "domContentLoaded",
  "load",
  "transferKB",
  "requestCount",
]);

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------
function percentile(values, p) {
  const nums = values.filter((v) => typeof v === "number" && !Number.isNaN(v));
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}
const median = (v) => percentile(v, 50);
const round = (n) => (typeof n === "number" && !Number.isNaN(n) ? Math.round(n * 100) / 100 : n);

// ---------------------------------------------------------------------------
// in-page observer install (runs before any page script)
// ---------------------------------------------------------------------------
function installObservers() {
  window.__perf = { lcp: null, cls: 0 };
  try {
    new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const last = entries[entries.length - 1];
      if (last) window.__perf.lcp = last.renderTime || last.loadTime || last.startTime;
    }).observe({ type: "largest-contentful-paint", buffered: true });
  } catch (e) {
    /* unsupported */
  }
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) window.__perf.cls += entry.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  } catch (e) {
    /* unsupported */
  }
}

// ---------------------------------------------------------------------------
// in-page metric collection
// ---------------------------------------------------------------------------
function collectMetrics() {
  const nav = performance.getEntriesByType("navigation")[0] || {};
  const paints = performance.getEntriesByType("paint");
  const fcpEntry = paints.find((p) => p.name === "first-contentful-paint");
  const resources = performance.getEntriesByType("resource");
  const perf = window.__perf || { lcp: null, cls: 0 };

  const transferBytes =
    (nav.transferSize || 0) + resources.reduce((sum, r) => sum + (r.transferSize || 0), 0);

  const widgetMarks = performance
    .getEntriesByType("mark")
    .filter((m) => m.name.startsWith("widget:"))
    .map((m) => ({ name: m.name, startTime: m.startTime }));

  return {
    ttfb: nav.responseStart || null,
    fcp: fcpEntry ? fcpEntry.startTime : null,
    lcp: perf.lcp,
    cls: perf.cls,
    domContentLoaded: nav.domContentLoadedEventEnd || null,
    load: nav.loadEventEnd || null,
    transferKB: transferBytes / 1024,
    requestCount: resources.length + (nav.name ? 1 : 0),
    widgetMarks,
  };
}

// ---------------------------------------------------------------------------
// single run
// ---------------------------------------------------------------------------
async function runOnce(browser, base, path) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  let requestCount = 0;
  let transferBytes = 0;
  page.on("response", () => {
    requestCount++;
  });

  await page.addInitScript(installObservers);

  const targetUrl = base.replace(/\/$/, "") + path;
  const resp = await page.goto(targetUrl, { waitUntil: "load", timeout: 60000 });
  const finalUrl = page.url();
  const status = resp ? resp.status() : null;

  await page.waitForTimeout(SETTLE_MS);

  const m = await page.evaluate(collectMetrics);

  // Prefer network-observed counts (covers redirects/non-resource fetches),
  // but keep the in-page resource count as a floor.
  m.requestCount = Math.max(m.requestCount || 0, requestCount);

  await context.close();

  return {
    ...m,
    status,
    redirected: finalUrl.replace(/\/$/, "") !== targetUrl.replace(/\/$/, ""),
    finalUrl,
  };
}

// ---------------------------------------------------------------------------
// aggregate
// ---------------------------------------------------------------------------
const METRIC_KEYS = [
  "ttfb",
  "fcp",
  "lcp",
  "cls",
  "domContentLoaded",
  "load",
  "transferKB",
  "requestCount",
];

function aggregate(runs) {
  const metrics = {};
  for (const key of METRIC_KEYS) {
    const vals = runs.map((r) => r[key]);
    metrics[key] = { median: round(median(vals)), p75: round(percentile(vals, 75)) };
  }
  return metrics;
}

// ---------------------------------------------------------------------------
// compare
// ---------------------------------------------------------------------------
function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function fmt(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return "n/a";
  return String(round(v));
}

function compareReports(baseline, current) {
  console.log("\n=== perf comparison (median) ===");
  let regressions = 0;
  const paths = new Set([
    ...Object.keys(baseline.pages || {}),
    ...Object.keys(current.pages || {}),
  ]);
  for (const path of paths) {
    const bp = baseline.pages?.[path]?.metrics;
    const cp = current.pages?.[path]?.metrics;
    console.log(`\n${path}`);
    console.log(
      `  ${pad("metric", 18)}${pad("baseline", 12)}${pad("current", 12)}${pad("delta", 12)}${pad("pct", 10)}flag`
    );
    for (const key of METRIC_KEYS) {
      const b = bp?.[key]?.median ?? null;
      const c = cp?.[key]?.median ?? null;
      let delta = "n/a";
      let pct = "n/a";
      let flag = "";
      if (typeof b === "number" && typeof c === "number") {
        const d = c - b;
        delta = (d > 0 ? "+" : "") + round(d);
        if (b !== 0) {
          const p = (d / b) * 100;
          pct = (p > 0 ? "+" : "") + round(p) + "%";
          // CLS is excluded from regression flagging per spec.
          if (key !== "cls" && LOWER_IS_BETTER.has(key) && p > 10) {
            flag = "⚠️  REGRESSION";
            regressions++;
          }
        } else if (d > 0) {
          pct = "new";
        }
      }
      console.log(
        `  ${pad(key, 18)}${pad(fmt(b), 12)}${pad(fmt(c), 12)}${pad(delta, 12)}${pad(pct, 10)}${flag}`
      );
    }
  }
  console.log(
    `\n=== ${regressions === 0 ? "✅ no regressions >10%" : `⚠️  ${regressions} regression(s) >10%`} ===\n`
  );
  return regressions;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv);

  const browser = await chromium.launch();
  const pages = {};

  try {
    for (const path of PAGES) {
      console.log(`\n[perf] benchmarking ${path} (${args.runs} runs) @ ${args.url}`);
      const runs = [];
      for (let i = 0; i < args.runs; i++) {
        const r = await runOnce(browser, args.url, path);
        runs.push(r);
        console.log(
          `  run ${i + 1}/${args.runs}: status=${r.status}${r.redirected ? ` (redirected -> ${r.finalUrl})` : ""} ` +
            `ttfb=${fmt(r.ttfb)} fcp=${fmt(r.fcp)} lcp=${fmt(r.lcp)} cls=${fmt(r.cls)} ` +
            `load=${fmt(r.load)} kb=${fmt(r.transferKB)} req=${r.requestCount}`
        );
      }
      const sampleRun = runs[runs.length - 1] || {};
      pages[path] = {
        runs: runs.length,
        status: sampleRun.status ?? null,
        redirected: !!sampleRun.redirected,
        finalUrl: sampleRun.finalUrl ?? null,
        metrics: aggregate(runs),
        sampleWidgetMarks: sampleRun.widgetMarks || [],
      };
    }
  } finally {
    await browser.close();
  }

  const report = {
    url: args.url,
    capturedAt: new Date().toISOString(),
    gitRef: process.env.GIT_REF ?? null,
    pages,
  };

  // Resolve output path. Default: web/perf-results/<timestamp>.json (gitignored).
  const outPath = args.out
    ? resolve(args.out)
    : resolve(`perf-results/${report.capturedAt.replace(/[:.]/g, "-")}.json`);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(report, null, 2) + "\n");
  console.log(`\n[perf] report written: ${outPath}`);

  if (args.compare) {
    const baselineRaw = await readFile(resolve(args.compare), "utf8");
    const baseline = JSON.parse(baselineRaw);
    const regressions = compareReports(baseline, report);
    if (regressions > 0) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("[perf] fatal:", err);
  process.exit(2);
});
