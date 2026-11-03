#!/usr/bin/env node
// Chart-code gate for the stock segment.
//
// No stock tab loads chart code with its page. The Overview, Short interest and
// Strategy each draw a chart, and each fetches it once the page is in the
// browser, through a "use client" loader that holds a next/dynamic call: a real
// import() in a client module, so the chart is a chunk of its own. CHART_LOADERS
// names the loader each chart route uses.
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
// The gate, on the build in .next:
//   1. A chart chunk is one holding `data-chart-capture`, the pointer-capture
//      rect only StockChart.tsx renders. If no chunk holds it, the marker has
//      moved and the gate would pass having checked nothing.
//   2. No stock tab's client manifest maps a client module to a chunk list with
//      a chart chunk in it, so no tab has the chart in its first load.
//   3. Each chart route's manifest maps its loader, and the loader's import in
//      .next/react-loadable-manifest.json lists a chart chunk. Without this,
//      check 2 would pass for a loader that never loads the chart.
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

/**
 * The stock routes that show a chart, and the client module (under src/@/) each
 * loads its chart through. The Overview and Short interest share one.
 */
export const CHART_LOADERS = {
  "/shorts/[stockCode]": "components/charts/stock-chart-panel-lazy.tsx",
  "/shorts/[stockCode]/short-interest": "components/charts/stock-chart-panel-lazy.tsx",
  "/shorts/[stockCode]/strategy": "components/strategy/strategy-levels-chart-loader.tsx",
};

/** The directory the loaders sit in, as the manifests name them (from src/). */
const LOADER_ROOT = "src/@/";

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

/**
 * A client module's name as the build writes it, from src/. The client manifest
 * names a module by its absolute path, the loadable manifest by its path under
 * src with the "@/" alias. Next lists a module under its CommonJS and its ESM
 * path too; it is named once, in the /dist/ form.
 */
function modulePath(name) {
  return name
    .replace(/^@\//, LOADER_ROOT)
    .replace(/^.*?\/(node_modules|src)\//, "$1/")
    .replace("/dist/esm/", "/dist/");
}

/** Whether a chunk file, as the manifests write it, is one that holds the chart. */
function isChartFile(chunks, entry) {
  return chunks.has(decodeURI(String(entry)).replace(/\?.*$/, ""));
}

/** The client modules a manifest maps to a chunk list with a chart chunk in it. */
function chartModules(manifest, chunks) {
  const names = new Set();
  for (const [name, ref] of Object.entries(manifest.clientModules)) {
    if (ref.chunks.some((entry, i) => i % 2 === 1 && isChartFile(chunks, entry))) {
      names.add(modulePath(name));
    }
  }
  return [...names];
}

/** Whether a manifest maps the loader at `file` (under src/@/). */
function mapsLoader(manifest, file) {
  return Object.keys(manifest.clientModules).some((name) => modulePath(name) === LOADER_ROOT + file);
}

/**
 * Whether the loadable manifest lists a chart chunk for the loader at `file`,
 * through the import it makes for its chart. Its keys are "<module> -> <import>".
 */
function loadsChart(loadable, file, chunks) {
  return Object.entries(loadable).some(
    ([key, entry]) =>
      modulePath(key.split(" -> ")[0]) === LOADER_ROOT + file &&
      (entry.files ?? []).some((f) => isChartFile(chunks, f)),
  );
}

function main(argv) {
  const i = argv.indexOf("--next");
  const nextDir = resolve(i >= 0 ? argv[i + 1] : ".next");
  let chunks;
  let loadable;
  const manifests = new Map();
  try {
    chunks = chartChunks(nextDir);
    loadable = JSON.parse(readFileSync(join(nextDir, "react-loadable-manifest.json"), "utf8"));
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
    // Check 2: no stock tab has the chart in its first load.
    for (const route of STOCK_ROUTES) {
      const names = chartModules(manifests.get(route), chunks);
      if (names.length) problems.push(`${route}: ${names.join(", ")}`);
    }
    // Check 3: each chart route loads its chart through its loader, and that
    // loader's import lists the chart's chunk.
    for (const [route, file] of Object.entries(CHART_LOADERS)) {
      if (!mapsLoader(manifests.get(route), file)) {
        problems.push(`${route}: maps no ${LOADER_ROOT}${file}, the client module that loads its chart`);
      }
    }
    for (const file of new Set(Object.values(CHART_LOADERS))) {
      if (!loadsChart(loadable, file, chunks)) {
        problems.push(
          `${LOADER_ROOT}${file}: its import in react-loadable-manifest.json lists no chart chunk, so the chart is not loaded through it. Is "${CHART_MARKER}" still the chart's?`,
        );
      }
    }
  }

  if (problems.length) {
    console.error(
      "stock-chart-chunks: a stock tab loads chart code with its page, or a chart route does not load its chart through its loader. These are the problems:",
    );
    for (const p of problems) console.error(`  ${p}`);
    console.error(
      "No stock tab may load the chart with its page: Next 14 merges the Overview page's client manifest into every tab's, so the Overview's first-load chunks are every tab's. " +
        "Load chart code after the page, through a client loader (stock-chart-panel-lazy.tsx or strategy-levels-chart-loader.tsx), never with a " +
        "next/dynamic in a server component.",
    );
    return 1;
  }
  console.log(
    `stock-chart-chunks: ${STOCK_ROUTES.length} stock tabs load no chart code with their page, and ` +
      `${Object.keys(CHART_LOADERS).length} chart routes load theirs through a client loader.`,
  );
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
