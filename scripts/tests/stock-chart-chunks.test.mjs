import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { CHART_LOADERS } from "../../web/scripts/stock-chart-chunks.mjs";
import { STOCK_ROUTES } from "../../web/scripts/route-kinds.mjs";

const script = fileURLToPath(new URL("../../web/scripts/stock-chart-chunks.mjs", import.meta.url));

const CHART_CHUNK = "static/chunks/42803-15c38fccd4e8d433.js";
const PLAIN_CHUNK = "static/chunks/231-0a1b2c3d4e5f6a7b.js";
const LINK = "/repo/web/node_modules/next/dist/client/link.js";
const PANEL = "/repo/web/src/@/components/charts/StockChartPanel.tsx";

/** A stock route's loader, as its client manifest names it: an absolute path under src/@/. */
const loaderOf = (route) => `/repo/web/src/@/${CHART_LOADERS[route]}`;

/** A client reference as Next writes it: chunk ids and files, interleaved. */
const ref = (id, ...files) => ({
  id,
  name: "*",
  chunks: files.flatMap((f) => [f.match(/(\d+)-/)?.[1] ?? "0", f]),
  async: false,
});

/**
 * react-loadable-manifest.json as Next 14 writes it for the two loaders: keyed
 * "<module, from src> -> <import>", and each import lists the chart's chunk.
 */
const LOADABLE = {
  "@/components/charts/stock-chart-panel-lazy.tsx -> ./StockChartPanel": { id: 1, files: [PLAIN_CHUNK, CHART_CHUNK] },
  "@/components/strategy/strategy-levels-chart-loader.tsx -> ./strategy-levels-chart": {
    id: 2,
    files: [PLAIN_CHUNK, CHART_CHUNK],
  },
};

/**
 * A .next directory with two chunks (one carrying the chart's marker), a client
 * reference manifest per stock route and the loadable manifest. `modules(route)`
 * says what a route's manifest maps. By default each chart route maps its loader
 * to a first-load chunk that does not hold the chart (as the build does), and
 * every route maps next/link to a plain chunk.
 */
function build(t, modules = () => undefined, loadable = LOADABLE) {
  const dir = mkdtempSync(join(tmpdir(), "shorted-chart-chunks-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "static", "chunks"), { recursive: true });
  writeFileSync(join(dir, CHART_CHUNK), 'e.jsx("rect",{"data-chart-capture":!0,width:n})');
  writeFileSync(join(dir, PLAIN_CHUNK), 'e.jsx("a",{href:t})');
  writeFileSync(join(dir, "react-loadable-manifest.json"), JSON.stringify(loadable));
  for (const route of STOCK_ROUTES) {
    const clientModules = modules(route) ??
      (CHART_LOADERS[route]
        ? { [loaderOf(route)]: ref("9", PLAIN_CHUNK), [LINK]: ref("231", PLAIN_CHUNK) }
        : { [LINK]: ref("231", PLAIN_CHUNK) });
    const file = join(dir, "server", "app", route, "page_client-reference-manifest.js");
    mkdirSync(dirname(file), { recursive: true });
    const key = JSON.stringify(`${route}/page`);
    writeFileSync(
      file,
      `globalThis.__RSC_MANIFEST=(globalThis.__RSC_MANIFEST||{});globalThis.__RSC_MANIFEST[${key}]=${JSON.stringify({ clientModules })}`,
    );
  }
  return dir;
}

const run = (dir) => spawnSync(process.execPath, [script, "--next", dir], { encoding: "utf8" });

test("the gate checks every stock tab, and each chart route is one of them", () => {
  assert.deepEqual(Object.keys(CHART_LOADERS).sort(), [
    "/shorts/[stockCode]",
    "/shorts/[stockCode]/short-interest",
    "/shorts/[stockCode]/strategy",
  ]);
  for (const route of Object.keys(CHART_LOADERS)) assert.ok(STOCK_ROUTES.includes(route), route);
});

test("passes when no stock tab maps the chart's chunk and each chart route loads it through its loader", (t) => {
  const result = run(build(t));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /7 stock tabs load no chart code with their page/);
  assert.match(result.stdout, /3 chart routes load theirs through a client loader/);
});

// What PR #712 shipped: Financials resolved next/link through the Overview's
// chunk list, the chart among it. A deployment id on the file must not hide it.
test("fails and names the tab and the module when another tab maps one to it", (t) => {
  const dir = build(t, (route) =>
    route === "/shorts/[stockCode]/financials"
      ? { [LINK]: ref("231", PLAIN_CHUNK, `${CHART_CHUNK}?dpl=dpl_abc`) }
      : undefined,
  );
  const result = run(dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\/shorts\/\[stockCode\]\/financials/);
  assert.match(result.stderr, /next\/dist\/client\/link\.js/);
  assert.doesNotMatch(result.stderr, /\/company/);
});

test("checks the Overview too: its first-load chunks are what every tab inherits", (t) => {
  const dir = build(t, (route) =>
    route === "/shorts/[stockCode]" ? { [PANEL]: ref("9", PLAIN_CHUNK, CHART_CHUNK) } : undefined,
  );
  const result = run(dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\/shorts\/\[stockCode\]: .*StockChartPanel\.tsx/);
});

// A gate that finds no chart chunk, or finds that a chart route no longer loads
// one, has lost its marker and would pass having checked nothing.
test("fails when no chunk carries the chart's marker", (t) => {
  const dir = build(t);
  writeFileSync(join(dir, CHART_CHUNK), 'e.jsx("rect",{width:n})');
  const result = run(dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no chunk carries/);
});

test("fails when a chart route does not map its loader", (t) => {
  const dir = build(t, (route) =>
    route === "/shorts/[stockCode]/short-interest" ? { [LINK]: ref("231", PLAIN_CHUNK) } : undefined,
  );
  const result = run(dir);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /\/shorts\/\[stockCode\]\/short-interest: maps no src\/@\/components\/charts\/stock-chart-panel-lazy\.tsx/,
  );
});

test("fails when a loader's import lists no chart chunk, so the chart is never loaded through it", (t) => {
  const dir = build(t, undefined, {
    ...LOADABLE,
    "@/components/strategy/strategy-levels-chart-loader.tsx -> ./strategy-levels-chart": {
      id: 2,
      files: [PLAIN_CHUNK],
    },
  });
  const result = run(dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /src\/@\/components\/strategy\/strategy-levels-chart-loader\.tsx: its import/);
  // The footer names both loaders; only the problem line may name the panel's.
  assert.doesNotMatch(result.stderr, /^ {2}src\/@\/components\/charts\/stock-chart-panel-lazy\.tsx:/m);
});

test("exits 2, never 1, and says to build first when a manifest cannot be read", (t) => {
  const dir = build(t);
  rmSync(join(dir, "server", "app", "shorts", "[stockCode]", "news"), { recursive: true });
  const result = run(dir);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Run `next build` first/);
  assert.equal(result.stdout, "", "a gate that could not run must not claim a pass");
});

test("exits 2 when the loadable manifest is missing, and says to build first", (t) => {
  const dir = build(t);
  rmSync(join(dir, "react-loadable-manifest.json"));
  const result = run(dir);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Run `next build` first/);
  assert.equal(result.stdout, "", "a gate that could not run must not claim a pass");
});

test("the CI workflow and the npm script run it after the ISR gate", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/perf-budget.yml", import.meta.url), "utf8");
  assert.match(workflow, /node scripts\/stock-chart-chunks\.mjs/);
  assert.ok(workflow.indexOf("stock-chart-chunks.mjs") > workflow.indexOf("route-kinds.mjs"));
  const pkg = JSON.parse(readFileSync(new URL("../../web/package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts["routes:charts"], "node scripts/stock-chart-chunks.mjs");
});
