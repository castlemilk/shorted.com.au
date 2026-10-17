import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { CHART_TABS, NO_CHART_TABS } from "../../web/scripts/stock-chart-chunks.mjs";
import { STOCK_ROUTES } from "../../web/scripts/route-kinds.mjs";

const script = fileURLToPath(new URL("../../web/scripts/stock-chart-chunks.mjs", import.meta.url));

const CHART_CHUNK = "static/chunks/42803-15c38fccd4e8d433.js";
const PLAIN_CHUNK = "static/chunks/231-0a1b2c3d4e5f6a7b.js";
const LINK = "/repo/web/node_modules/next/dist/client/link.js";
const PANEL = "/repo/web/src/@/components/charts/StockChartPanel.tsx";

/** A client reference as Next writes it: chunk ids and files, interleaved. */
const ref = (id, ...files) => ({
  id,
  name: "*",
  chunks: files.flatMap((f) => [f.match(/(\d+)-/)?.[1] ?? "0", f]),
  async: false,
});

/**
 * A .next directory with two chunks (one carrying the chart's marker) and a
 * client reference manifest per stock route. `modules(route)` says what each
 * route's manifest maps; by default the chart tabs map the panel to the chart
 * chunk and every other tab maps only next/link to a plain one.
 */
function build(t, modules = () => undefined) {
  const dir = mkdtempSync(join(tmpdir(), "shorted-chart-chunks-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "static", "chunks"), { recursive: true });
  writeFileSync(join(dir, CHART_CHUNK), 'e.jsx("rect",{"data-chart-capture":!0,width:n})');
  writeFileSync(join(dir, PLAIN_CHUNK), 'e.jsx("a",{href:t})');
  for (const route of STOCK_ROUTES) {
    const clientModules = modules(route) ??
      (CHART_TABS.includes(route)
        ? { [PANEL]: ref("9", CHART_CHUNK), [LINK]: ref("231", PLAIN_CHUNK, CHART_CHUNK) }
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

test("every stock tab is either a chart tab or a tab the gate checks", () => {
  assert.deepEqual([...CHART_TABS, ...NO_CHART_TABS].sort(), [...STOCK_ROUTES].sort());
  assert.deepEqual([...CHART_TABS].sort(), ["/shorts/[stockCode]/short-interest", "/shorts/[stockCode]/strategy"]);
});

test("passes when only the chart tabs map a module to the chart's chunk", (t) => {
  const result = run(build(t));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /5 stock tabs load no chart code/);
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

// A gate that finds no chart chunk, or finds that no chart tab maps one, has
// lost its marker and would pass having checked nothing.
test("fails when no chunk carries the chart's marker", (t) => {
  const dir = build(t);
  writeFileSync(join(dir, CHART_CHUNK), 'e.jsx("rect",{width:n})');
  const result = run(dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no chunk carries/);
});

test("fails when a chart tab maps no module to the chart's chunk", (t) => {
  const dir = build(t, (route) =>
    route === "/shorts/[stockCode]/short-interest" ? { [LINK]: ref("231", PLAIN_CHUNK) } : undefined,
  );
  const result = run(dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /short-interest/);
});

test("exits 2, never 1, and says to build first when a manifest cannot be read", (t) => {
  const dir = build(t);
  rmSync(join(dir, "server", "app", "shorts", "[stockCode]", "news"), { recursive: true });
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
