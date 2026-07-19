#!/usr/bin/env node
// Lighthouse benchmark for the Shorted web app.
//
// Runs Lighthouse (mobile OR desktop preset, matching PageSpeed Insights) over
// a curated set of REAL routes, N times each, takes the median, enforces score
// + Core-Web-Vitals budgets, and (optionally) compares against a committed
// baseline to catch regressions. Emits a machine-readable JSON report.
//
// Usage:
//   node scripts/lighthouse-bench.mjs [options]
//     --url <base>        base URL (default http://localhost:3020)
//     --preset <p>        mobile | desktop           (default mobile)
//     --runs <n>          runs per route, median wins (default 3)
//     --pages "a,b,c"     comma-separated routes      (default curated set)
//     --out <path>        JSON report path            (default perf-results/lh-<preset>-<ts>.json)
//     --compare <path>    baseline JSON to diff against; regressions -> exit 1
//     --update-baseline <path>   write this run to <path> and skip budget/exit gates
//     --no-budgets        report only; never exit non-zero on budget breach
//
// Requires a server already serving <base> (prefer a PRODUCTION build:
// `npm run build && npm run start`). Chrome is auto-detected by chrome-launcher;
// override with CHROME_PATH (e.g. the Playwright chromium in CI).
//
// See scripts/bundle-budget.mjs for the static JS-size companion, and
// .claude/skills/perf-optimization/SKILL.md for the full playbook.

import lighthouse from "lighthouse";
import * as chromeLauncher from "chrome-launcher";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------
const DEFAULT_PAGES = [
  "/", // homepage — top-shorts, industry treemap, news grid (external imgs)
  "/shorts/BHP", // dynamic stock page — the highest-traffic template
  "/news", // news grid — the NewsCard/external-image surface
  "/screener", // data-dense interactive table
  "/methodology", // static content page — a clean floor to catch regressions
];

// Median-of-runs budgets. Scores are 0-1; metrics are milliseconds except CLS.
// Tuned as a coarse *regression guard* for the LOCAL/CI measurement environment
// (a local `next start` fetching the LIVE API under simulated slow-4G — so LCP
// is dominated by cross-internet API latency and reads much higher than CDN
// PageSpeed). The meaningful gate is --compare against the committed baseline;
// these absolute numbers only catch catastrophic breaks. Do NOT compare these
// to pagespeed.web.dev numbers — different network path. See the skill.
const BUDGETS = {
  mobile: {
    scores: { performance: 0.55, accessibility: 0.95, "best-practices": 0.9, seo: 0.9 },
    metrics: { "largest-contentful-paint": 14000, "total-blocking-time": 500, "cumulative-layout-shift": 0.15, "first-contentful-paint": 6000 },
  },
  desktop: {
    scores: { performance: 0.7, accessibility: 0.95, "best-practices": 0.9, seo: 0.9 },
    metrics: { "largest-contentful-paint": 6000, "total-blocking-time": 400, "cumulative-layout-shift": 0.15, "first-contentful-paint": 3000 },
  },
};

const CATEGORIES = ["performance", "accessibility", "best-practices", "seo"];
const METRICS = [
  "first-contentful-paint",
  "largest-contentful-paint",
  "total-blocking-time",
  "cumulative-layout-shift",
  "speed-index",
  "interactive",
];

// Standard Lighthouse throttling presets (mirror the PageSpeed form factors).
const PRESETS = {
  mobile: {
    formFactor: "mobile",
    screenEmulation: { mobile: true, width: 412, height: 823, deviceScaleFactor: 1.75, disabled: false },
    throttling: { rttMs: 150, throughputKbps: 1638.4, requestLatencyMs: 562.5, downloadThroughputKbps: 1474.56, uploadThroughputKbps: 675, cpuSlowdownMultiplier: 4 },
  },
  desktop: {
    formFactor: "desktop",
    screenEmulation: { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false },
    throttling: { rttMs: 40, throughputKbps: 10240, requestLatencyMs: 0, downloadThroughputKbps: 0, uploadThroughputKbps: 0, cpuSlowdownMultiplier: 1 },
  },
};

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { url: "http://localhost:3020", preset: "mobile", runs: 3, pages: null, out: null, compare: null, updateBaseline: null, budgets: true };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") args.url = argv[++i];
    else if (a === "--preset") args.preset = argv[++i];
    else if (a === "--desktop") args.preset = "desktop";
    else if (a === "--mobile") args.preset = "mobile";
    else if (a === "--runs") args.runs = parseInt(argv[++i], 10);
    else if (a === "--pages") args.pages = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--compare") args.compare = argv[++i];
    else if (a === "--update-baseline") args.updateBaseline = argv[++i];
    else if (a === "--no-budgets") args.budgets = false;
    else console.warn(`[lh] ignoring unknown arg: ${a}`);
  }
  if (!Number.isFinite(args.runs) || args.runs < 1) args.runs = 3;
  if (!PRESETS[args.preset]) throw new Error(`unknown preset "${args.preset}" (use mobile|desktop)`);
  if (!args.pages) args.pages = DEFAULT_PAGES;
  return args;
}

// ---------------------------------------------------------------------------
// stats + formatting
// ---------------------------------------------------------------------------
function median(values) {
  const nums = values.filter((v) => typeof v === "number" && !Number.isNaN(v)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}
const round = (n, d = 0) => (typeof n === "number" && !Number.isNaN(n) ? Math.round(n * 10 ** d) / 10 ** d : n);
const pad = (s, n) => { s = String(s); return s.length >= n ? s : s + " ".repeat(n - s.length); };

// ---------------------------------------------------------------------------
// one lighthouse run
// ---------------------------------------------------------------------------
async function runLighthouse(url, port, preset) {
  const flags = { port, output: "json", logLevel: "error", onlyCategories: CATEGORIES };
  const config = {
    extends: "lighthouse:default",
    settings: { ...PRESETS[preset], throttlingMethod: "simulate", onlyCategories: CATEGORIES },
  };
  const result = await lighthouse(url, flags, config);
  const lhr = result?.lhr;
  if (!lhr) throw new Error(`no lhr for ${url}`);
  const scores = {};
  for (const c of CATEGORIES) scores[c] = lhr.categories?.[c]?.score ?? null;
  const metrics = {};
  for (const m of METRICS) metrics[m] = lhr.audits?.[m]?.numericValue ?? null;
  return { scores, metrics };
}

// ---------------------------------------------------------------------------
// per-page aggregate (median across runs)
// ---------------------------------------------------------------------------
function aggregate(runs) {
  const scores = {};
  for (const c of CATEGORIES) scores[c] = round(median(runs.map((r) => r.scores[c])), 3);
  const metrics = {};
  for (const m of METRICS) {
    const isCls = m === "cumulative-layout-shift";
    metrics[m] = round(median(runs.map((r) => r.metrics[m])), isCls ? 3 : 0);
  }
  return { scores, metrics };
}

// ---------------------------------------------------------------------------
// budget enforcement
// ---------------------------------------------------------------------------
function checkBudgets(report) {
  const budget = BUDGETS[report.preset];
  const failures = [];
  for (const [path, page] of Object.entries(report.pages)) {
    for (const [cat, min] of Object.entries(budget.scores)) {
      const got = page.scores[cat];
      if (typeof got === "number" && got < min)
        failures.push(`${path}  ${cat} ${got} < ${min}`);
    }
    for (const [metric, max] of Object.entries(budget.metrics)) {
      const got = page.metrics[metric];
      if (typeof got === "number" && got > max)
        failures.push(`${path}  ${metric} ${got} > ${max}`);
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------
// baseline compare (flag >5% worse on metrics or >2pt worse on scores)
// ---------------------------------------------------------------------------
function compareBaseline(baseline, current) {
  console.log(`\n=== vs baseline (${baseline.capturedAt ?? "?"}, ${baseline.preset}) ===`);
  let regressions = 0;
  for (const path of Object.keys(current.pages)) {
    const b = baseline.pages?.[path];
    const c = current.pages[path];
    if (!b) continue;
    for (const cat of CATEGORIES) {
      const bv = b.scores?.[cat], cv = c.scores?.[cat];
      if (typeof bv === "number" && typeof cv === "number" && cv < bv - 0.02) {
        console.log(`  ⚠️  ${path} ${cat}: ${bv} → ${cv}`);
        regressions++;
      }
    }
    for (const m of METRICS) {
      const bv = b.metrics?.[m], cv = c.metrics?.[m];
      if (typeof bv === "number" && typeof cv === "number" && bv > 0 && cv > bv * 1.05 && cv - bv > (m === "cumulative-layout-shift" ? 0.02 : 30)) {
        console.log(`  ⚠️  ${path} ${m}: ${bv} → ${cv}`);
        regressions++;
      }
    }
  }
  console.log(regressions === 0 ? "  ✅ no regressions" : `  ⚠️  ${regressions} regression(s)`);
  return regressions;
}

// ---------------------------------------------------------------------------
// table
// ---------------------------------------------------------------------------
function printTable(report) {
  console.log(`\n=== Lighthouse (${report.preset}, median of ${report.runs}) @ ${report.url} ===`);
  console.log(`  ${pad("route", 18)}${pad("perf", 7)}${pad("a11y", 7)}${pad("bp", 7)}${pad("seo", 7)}${pad("LCP", 9)}${pad("TBT", 8)}${pad("CLS", 8)}`);
  for (const [path, p] of Object.entries(report.pages)) {
    const s = p.scores, m = p.metrics;
    const sc = (v) => (typeof v === "number" ? Math.round(v * 100) : "—");
    console.log(
      `  ${pad(path, 18)}${pad(sc(s.performance), 7)}${pad(sc(s.accessibility), 7)}${pad(sc(s["best-practices"]), 7)}${pad(sc(s.seo), 7)}` +
      `${pad((m["largest-contentful-paint"] ?? "—") + "ms", 9)}${pad((m["total-blocking-time"] ?? "—") + "ms", 8)}${pad(m["cumulative-layout-shift"] ?? "—", 8)}`
    );
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv);

  const chrome = await chromeLauncher.launch({
    chromeFlags: ["--headless=new", "--no-sandbox", "--disable-gpu"],
    chromePath: process.env.CHROME_PATH || undefined,
  });

  const pages = {};
  try {
    for (const path of args.pages) {
      const url = args.url.replace(/\/$/, "") + path;
      process.stdout.write(`[lh] ${args.preset} ${path} `);
      const runs = [];
      for (let i = 0; i < args.runs; i++) {
        try {
          runs.push(await runLighthouse(url, chrome.port, args.preset));
          process.stdout.write("•");
        } catch (e) {
          process.stdout.write("x");
          console.warn(`\n[lh] run failed for ${path}: ${e.message}`);
        }
      }
      process.stdout.write("\n");
      if (runs.length) pages[path] = { runs: runs.length, ...aggregate(runs) };
    }
  } finally {
    await chrome.kill();
  }

  const report = {
    url: args.url,
    preset: args.preset,
    runs: args.runs,
    capturedAt: new Date().toISOString(),
    gitRef: process.env.GIT_REF ?? null,
    pages,
  };

  printTable(report);

  const outPath = args.updateBaseline
    ? resolve(args.updateBaseline)
    : args.out
      ? resolve(args.out)
      : resolve(`perf-results/lh-${args.preset}-${report.capturedAt.replace(/[:.]/g, "-")}.json`);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(report, null, 2) + "\n");
  console.log(`\n[lh] report: ${outPath}`);

  if (args.updateBaseline) {
    console.log(`[lh] baseline updated — budgets/compare skipped.`);
    return;
  }

  let failed = false;
  if (args.budgets) {
    const failures = checkBudgets(report);
    if (failures.length) {
      console.log(`\n=== ❌ ${failures.length} budget breach(es) (${args.preset}) ===`);
      failures.forEach((f) => console.log(`  ${f}`));
      failed = true;
    } else {
      console.log(`\n=== ✅ all ${args.preset} budgets met ===`);
    }
  }
  if (args.compare) {
    const baseline = JSON.parse(await readFile(resolve(args.compare), "utf8"));
    if (compareBaseline(baseline, report) > 0) failed = true;
  }
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error("[lh] fatal:", err);
  process.exit(2);
});
