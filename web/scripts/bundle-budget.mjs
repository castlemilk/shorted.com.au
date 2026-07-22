#!/usr/bin/env node
// First-load JS bundle budget for the Shorted web app.
//
// Tracks the authoritative "First Load JS" per route — the number Next.js
// itself computes and prints in the build table (async/dynamically-imported
// chunks correctly EXCLUDED). Enforces per-route budgets, tracks the
// shared-by-all baseline, and diffs against a committed baseline so a
// dependency bloat / accidental eager import fails the PR in CI.
//
// Why parse the build table instead of the manifests: `app-build-manifest.json`
// lists EVERY chunk associated with a route including lazy `dynamic()` imports
// (the root /layout entry alone is ~2.7MB raw here), so summing it overstates
// first-load ~4x. Next's printed table is the ground truth.
//
// Usage (run AFTER / around a production build):
//   next build | tee build.log ; node scripts/bundle-budget.mjs --build-log build.log
//   node scripts/bundle-budget.mjs                # no --build-log → runs the build itself
//     --build-log <path>    parse an existing `next build` log instead of building
//     --out <path>          JSON report path      (default perf-results/bundle-<ts>.json)
//     --compare <path>      baseline JSON; >5% growth on any route -> exit 1
//     --update-baseline <p> write this run to <p>, skip gates
//     --no-budgets          report only
//
// See scripts/lighthouse-bench.mjs (runtime metrics) and
// .claude/skills/perf-optimization/SKILL.md for the full playbook.

import { execSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

// Budgets are in kB (matching Next's printed unit) — regression guards, set a
// little above today's worst. Real gate is --compare against the baseline.
const BUDGETS = {
  sharedByAll: 110,
  default: 300,
  routes: {
    // Public, SEO-critical routes — tighter guards (current value + headroom).
    "/": 185,
    "/stocks": 225,
    // 2026-07-22: shorts.proto split into per-domain files (market/stock/
    // housing/...), each with its own service — routes now carry only their
    // own domain's descriptor instead of the monolithic 66.7KB blob. The
    // shorts-RPC routes dropped 25-31kB each; budgets tightened back to the
    // new floor + headroom. Keep new messages in the right domain file — a
    // message added to a domain lands only in that domain's importers.
    "/shorts/[stockCode]": 330,
    "/news/[slug]": 315,
    "/screener": 250,
    "/dashboards": 280,
    // Known-heavy / non-public routes — guarded at current + headroom. These
    // are acknowledged tech debt (chat pulls markdown+mermaid+katex; trim via
    // dynamic import if they grow). Tighten as they're optimized.
    "/chat": 740,
    "/admin/takes/[slug]": 620,
    "/e2e-chat-render": 620,
  },
};

function parseArgs(argv) {
  const args = { buildLog: null, out: null, compare: null, updateBaseline: null, budgets: true };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--build-log") args.buildLog = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--compare") args.compare = argv[++i];
    else if (a === "--update-baseline") args.updateBaseline = argv[++i];
    else if (a === "--no-budgets") args.budgets = false;
    else console.warn(`[bundle] ignoring unknown arg: ${a}`);
  }
  return args;
}

const pad = (s, n) => { s = String(s); return s.length >= n ? s : s + " ".repeat(n - s.length); };
const padL = (s, n) => { s = String(s); return s.length >= n ? s : " ".repeat(n - s.length) + s; };
// eslint-disable-next-line no-control-regex
const stripAnsi = (s) => s.replace(/\[[0-9;]*m/g, "");

// "20.6 kB" / "1.2 MB" / "512 B" → kB (float).
function toKB(value, unit) {
  const n = parseFloat(value);
  if (unit === "MB") return n * 1024;
  if (unit === "B") return n / 1024;
  return n; // kB
}

// Parse Next's build table. Route rows look like (after ANSI strip):
//   ├ ○ /stocks                         20.6 kB         204 kB
//   ┌ ƒ /shorts/[stockCode]             7.9 kB          220 kB
// The LAST size on a route line is First Load JS. Also grab the
// "First Load JS shared by all" summary line.
function parseBuildTable(text) {
  const routes = {};
  let sharedByAll = null;
  for (const rawLine of text.split("\n")) {
    const line = stripAnsi(rawLine);

    const shared = line.match(/First Load JS shared by all\s+([\d.]+)\s*(kB|MB|B)/);
    if (shared) { sharedByAll = toKB(shared[1], shared[2]); continue; }

    // Skip non-route rows (Middleware, legends, headers).
    if (/Middleware/.test(line)) continue;
    // A route token: a "/..." path surrounded by whitespace on the line.
    const routeMatch = line.match(/[│├└┌\s][○●ƒλ]\s+(\/\S*)/);
    if (!routeMatch) continue;
    const route = routeMatch[1];

    const sizes = [...line.matchAll(/([\d.]+)\s*(kB|MB|B)\b/g)];
    if (!sizes.length) continue;
    const last = sizes[sizes.length - 1];
    const firstLoadKB = Math.round(toKB(last[1], last[2]) * 10) / 10;
    routes[route] = { firstLoadKB };
  }
  return { routes, sharedByAll };
}

async function main() {
  const args = parseArgs(process.argv);

  let logText;
  if (args.buildLog) {
    logText = await readFile(resolve(args.buildLog), "utf8");
  } else {
    console.log("[bundle] no --build-log given; running `next build` (this takes a few minutes)…");
    logText = execSync("npx next build", { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024 });
  }

  const { routes, sharedByAll } = parseBuildTable(logText);
  if (!Object.keys(routes).length) {
    console.error("[bundle] parsed 0 routes — is this a `next build` log? (looked for the route/First-Load-JS table)");
    process.exit(2);
  }

  const report = {
    capturedAt: new Date().toISOString(),
    gitRef: process.env.GIT_REF ?? null,
    unit: "kB (Next First Load JS, raw)",
    sharedByAllKB: sharedByAll,
    routes,
  };

  // ---- print ----
  console.log(`\n=== First Load JS — ${Object.keys(routes).length} routes (shared-by-all ${sharedByAll ?? "?"}kB) ===`);
  const sorted = Object.entries(routes).sort((a, b) => b[1].firstLoadKB - a[1].firstLoadKB);
  console.log(`  ${pad("route", 44)}${padL("first-load", 12)}${padL("budget", 9)}`);
  for (const [route, r] of sorted.slice(0, 25)) {
    const budget = BUDGETS.routes[route] ?? BUDGETS.default;
    console.log(`  ${pad(route, 44)}${padL(r.firstLoadKB + "kB", 12)}${padL(budget + "kB", 9)}${r.firstLoadKB > budget ? "  ❌" : ""}`);
  }
  if (sorted.length > 25) console.log(`  … ${sorted.length - 25} more (lighter)`);

  // ---- write ----
  const outPath = args.updateBaseline
    ? resolve(args.updateBaseline)
    : args.out
      ? resolve(args.out)
      : resolve(`perf-results/bundle-${report.capturedAt.replace(/[:.]/g, "-")}.json`);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(report, null, 2) + "\n");
  console.log(`\n[bundle] report: ${outPath}`);

  if (args.updateBaseline) {
    console.log("[bundle] baseline updated — gates skipped.");
    return;
  }

  // ---- gates ----
  let failed = false;
  if (args.budgets) {
    const breaches = [];
    if (typeof sharedByAll === "number" && sharedByAll > BUDGETS.sharedByAll)
      breaches.push(`shared-by-all ${sharedByAll}kB > ${BUDGETS.sharedByAll}kB`);
    for (const [route, r] of Object.entries(routes)) {
      const budget = BUDGETS.routes[route] ?? BUDGETS.default;
      if (r.firstLoadKB > budget) breaches.push(`${route} ${r.firstLoadKB}kB > ${budget}kB`);
    }
    if (breaches.length) {
      console.log(`\n=== ❌ ${breaches.length} bundle budget breach(es) ===`);
      breaches.forEach((b) => console.log(`  ${b}`));
      failed = true;
    } else {
      console.log(`\n=== ✅ all bundle budgets met ===`);
    }
  }
  if (args.compare) {
    const baseline = JSON.parse(await readFile(resolve(args.compare), "utf8"));
    console.log(`\n=== vs baseline (${baseline.capturedAt ?? "?"}) ===`);
    let regressions = 0;
    if (typeof baseline.sharedByAllKB === "number" && typeof sharedByAll === "number" && sharedByAll > baseline.sharedByAllKB * 1.05 && sharedByAll - baseline.sharedByAllKB > 3) {
      console.log(`  ⚠️  shared-by-all: ${baseline.sharedByAllKB}kB → ${sharedByAll}kB`);
      regressions++;
    }
    for (const [route, r] of Object.entries(routes)) {
      const b = baseline.routes?.[route]?.firstLoadKB;
      if (typeof b === "number" && r.firstLoadKB > b * 1.05 && r.firstLoadKB - b > 5) {
        console.log(`  ⚠️  ${route}: ${b}kB → ${r.firstLoadKB}kB`);
        regressions++;
      }
    }
    console.log(regressions === 0 ? "  ✅ no regressions" : `  ⚠️  ${regressions} regression(s)`);
    if (regressions > 0) failed = true;
  }
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error("[bundle] fatal:", err);
  process.exit(2);
});
