#!/usr/bin/env node
// Chart-code gate for the stock segment.
//
// Only the Short interest and Strategy tabs load a chart with the page. The
// Overview draws one too, but loads it after the page, through
// src/@/components/charts/stock-chart-panel-lazy.tsx, and that is what this
// gate holds in place.
//
// Next 14 builds each page's client reference manifest from the manifests of
// every page and layout above it (flight-manifest-plugin.js), and each maps a
// client module to the whole first-load chunk list of the page that holds it.
// The Overview is the page above the six other tabs, so a tab that resolves a
// shared module (next/link) through the Overview's mapping downloads all of the
// Overview's first-load chunks. A route group does not change that: the plugin
// strips it from the group name. Measured on PR #712's build, with the panel a
// `next/dynamic` import in the Overview page itself (bundled eagerly into the
// page's entry), the Financials and Community tabs downloaded the chart's chunk
// to resolve next/link.
//
// The gate: no client module in the manifest of the Overview or of any tab
// without a chart maps to a chunk that carries the chart's code. A chart chunk
// is one holding `data-chart-capture`, the pointer-capture rect only
// StockChart.tsx renders. Every chart tab must map one, or the marker has moved
// and the gate would pass having checked nothing.
//
// What it cannot see: a fetch that module code starts at runtime. Loading the
// Overview's page chunk on another tab runs every client module the Overview
// has, so an import() at the top of one of them downloads the chart there with
// no manifest saying so (it happened: stock-chart-panel-lazy.tsx now guards its
// own). That is checked where it happens, in the browser, by
// web/e2e/stock-tabs.spec.ts ("a tab without a chart downloads none of the
// chart's code"), and for that module by its Jest test.
//
// Run after `next build`:
//   node scripts/stock-chart-chunks.mjs [--next .next]

import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { STOCK_ROUTES } from "./route-kinds.mjs";

/** A string only StockChart.tsx puts in a bundle. */
export const CHART_MARKER = "data-chart-capture";

/** The tabs that load a chart with the page. */
export const CHART_TABS = [
  "/shorts/[stockCode]/short-interest",
  "/shorts/[stockCode]/strategy",
];

/** Every other stock tab, the Overview among them. */
export const NO_CHART_TABS = STOCK_ROUTES.filter((route) => !CHART_TABS.includes(route));

/** The emitted chunk files (as the manifests name them) that carry the chart. */
function chartChunks(nextDir) {
  const found = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".js") && readFileSync(path, "utf8").includes(CHART_MARKER)) {
        found.add(relative(nextDir, path).split("\\").join("/"));
      }
    }
  };
  walk(join(nextDir, "static", "chunks"));
  return found;
}

function readManifest(nextDir, route) {
  const file = join(nextDir, "server", "app", route, "page_client-reference-manifest.js");
  const sandbox = { globalThis: {} };
  vm.runInNewContext(readFileSync(file, "utf8"), sandbox);
  const manifest = sandbox.globalThis.__RSC_MANIFEST?.[`${route}/page`];
  if (!manifest?.clientModules) throw new Error(`${file} holds no manifest for ${route}/page`);
  return manifest;
}

/** The client modules a manifest maps to a chunk list with a chart chunk in it. */
function chartModules(manifest, chunks) {
  return Object.entries(manifest.clientModules)
    .filter(([, ref]) =>
      ref.chunks.some(
        (entry, i) => i % 2 === 1 && chunks.has(decodeURI(String(entry)).replace(/\?.*$/, "")),
      ),
    )
    .map(([name]) => name);
}

function main(argv) {
  const i = argv.indexOf("--next");
  const nextDir = resolve(i >= 0 ? argv[i + 1] : ".next");
  let chunks;
  const manifests = new Map();
  try {
    chunks = chartChunks(nextDir);
    for (const route of STOCK_ROUTES) manifests.set(route, readManifest(nextDir, route));
  } catch (err) {
    console.error(`stock-chart-chunks: cannot read the build in ${nextDir}: ${err.message}. Run \`next build\` first.`);
    return 2;
  }

  const problems = [];
  if (chunks.size === 0) {
    problems.push(
      `no chunk carries "${CHART_MARKER}": StockChart.tsx no longer renders it, so this gate cannot find the chart. Update CHART_MARKER.`,
    );
  } else {
    for (const route of CHART_TABS) {
      if (chartModules(manifests.get(route), chunks).length === 0) {
        problems.push(`${route}: maps nothing to the chart's chunks, which a chart tab must. Is "${CHART_MARKER}" still the chart's?`);
      }
    }
    for (const route of NO_CHART_TABS) {
      // Next lists a module under its CommonJS and its ESM path; name it once.
      const names = new Set(
        chartModules(manifests.get(route), chunks).map((name) =>
          name.replace(/^.*?\/(node_modules|src)\//, "$1/").replace("/dist/esm/", "/dist/"),
        ),
      );
      if (names.size) problems.push(`${route}: ${[...names].join(", ")}`);
    }
  }

  if (problems.length) {
    console.error(
      "stock-chart-chunks: a stock tab without a chart would download the chart's code. These map to a chunk list with it:",
    );
    for (const p of problems) console.error(`  ${p}`);
    console.error(
      "The Overview's first-load chunks are every tab's (Next 14 merges its client manifest into theirs). " +
        "Load chart code on the Overview after the page, through stock-chart-panel-lazy.tsx, never with a " +
        "next/dynamic in a server component there.",
    );
    return 1;
  }
  console.log(`stock-chart-chunks: ${NO_CHART_TABS.length} stock tabs load no chart code.`);
  return 0;
}

// Run only when executed directly, not when imported (see route-kinds.mjs for
// why both sides go through realpath).
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.exit(main(process.argv.slice(2)));
}
