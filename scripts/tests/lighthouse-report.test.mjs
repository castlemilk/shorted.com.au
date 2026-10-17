import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATEGORIES, METRICS, aggregateRuns, checkBudgets, measurementFailures, summarizeLhr } from "../../web/scripts/lighthouse-report.mjs";

const budget = { scores: { performance: 0.55, accessibility: 0.95, "best-practices": 0.9, seo: 0.9 }, metrics: { "largest-contentful-paint": 14000, "total-blocking-time": 500, "cumulative-layout-shift": 0.15, "first-contentful-paint": 6000 } };
function complete() { return { scores: Object.fromEntries(CATEGORIES.map((key) => [key, 1])), metrics: Object.fromEntries(METRICS.map((key) => [key, key === "cumulative-layout-shift" ? 0 : key === "interactive" ? null : 100])) }; }
function report(page, paths = ["/"]) { return { preset: "mobile", runs: 3, requestedPages: paths, pages: { "/": page } }; }

test("complete medians pass budgets and zero measurements remain valid", () => {
  const runs = [complete(), complete(), complete()];
  runs[0].metrics["largest-contentful-paint"] = 1000;
  runs[1].metrics["largest-contentful-paint"] = 0;
  const page = aggregateRuns(runs, 3);
  assert.equal(page.status, "complete");
  assert.equal(page.metrics["largest-contentful-paint"], 100);
  assert.equal(page.metrics.interactive, null);
  assert.deepEqual(checkBudgets(report(page), budget), []);
});

test("null Lighthouse values are incomplete measurements rather than passing budgets", () => {
  const page = aggregateRuns([summarizeLhr({}), summarizeLhr({}), summarizeLhr({})], 3);
  assert.equal(page.status, "incomplete");
  assert.match(checkBudgets(report(page), budget)[0], /incomplete measurements.*missing performance/);
});

test("a runtimeError fails coverage even when the LHR contains numerical scores", () => {
  const run = complete();
  run.runtimeError = { code: "NO_FCP" };
  const page = aggregateRuns([complete(), run, complete()], 3);
  assert.equal(page.status, "incomplete");
  assert.match(measurementFailures(report(page))[0], /NO_FCP/);
});

test("a failed or missing run cannot be hidden by successful medians", () => {
  const failed = { scores: {}, metrics: {}, runtimeError: { code: "RUN_FAILED" } };
  assert.equal(aggregateRuns([complete(), complete(), failed], 3).status, "incomplete");
  assert.equal(aggregateRuns([complete(), complete()], 3).status, "incomplete");
  const errors = measurementFailures(report(aggregateRuns([complete(), complete(), complete()], 3), ["/", "/news"]));
  assert.deepEqual(errors, ["/news  no measurements"]);
});

test("non-finite and out-of-range values are not measurements", () => {
  for (const value of [NaN, Infinity, -Infinity, null, "100", -1]) {
    const run = complete();
    run.metrics["largest-contentful-paint"] = value;
    assert.equal(aggregateRuns([run], 1).status, "incomplete");
  }
});

test("measured budget breaches still fail at the existing thresholds", () => {
  const run = complete();
  run.scores.accessibility = 0.94;
  run.metrics["largest-contentful-paint"] = 14001;
  const failures = checkBudgets(report(aggregateRuns([run, run, run], 3)), budget);
  assert.ok(failures.includes("/  accessibility 0.94 < 0.95"));
  assert.ok(failures.includes("/  largest-contentful-paint 14001 > 14000"));
});

test("runtime diagnostics retain a fixed code without the raw URL or error message", () => {
  const run = summarizeLhr({ runtimeError: { code: "PRIVATE_TOKEN", message: "https://fixture.test/?token=private-token" } });
  assert.deepEqual(run.runtimeError, { code: "UNKNOWN_RUNTIME_ERROR" });
  assert.ok(!JSON.stringify(run).includes("private-token"));
});

test("the real CLI exits nonzero and preserves the baseline on incomplete measurements, even without budgets", () => {
  const dir = mkdtempSync(join(tmpdir(), "shorted-lighthouse-offline-"));
  try {
    const loader = join(dir, "loader.mjs");
    // Replace only the Chrome/Lighthouse boundaries. The production CLI and
    // report code execute unchanged, with no browser or network requests.
    writeFileSync(loader, `
      export async function resolve(specifier, context, nextResolve) {
        const source = specifier === "lighthouse"
          ? 'export default async () => ({ lhr: { runtimeError: { code: "NO_FCP" } } });'
          : specifier === "chrome-launcher"
            ? 'export async function launch() { return { port: 0, kill: async () => {} }; }'
            : null;
        return source ? { url: "data:text/javascript," + encodeURIComponent(source), shortCircuit: true }
          : nextResolve(specifier, context);
      }
    `);
    const baseline = join(dir, "baseline.json");
    const output = join(dir, "report.json");
    writeFileSync(baseline, "baseline sentinel\n");
    const result = spawnSync(process.execPath, [
      "--experimental-loader", loader,
      new URL("../../web/scripts/lighthouse-bench.mjs", import.meta.url).pathname,
      "--pages", "/news", "--runs", "1", "--out", output,
      "--update-baseline", baseline, "--no-budgets",
    ], { encoding: "utf8", timeout: 5_000 });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(readFileSync(baseline, "utf8"), "baseline sentinel\n");
    const report = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(report.pages["/news"].status, "incomplete");
    assert.equal(report.pages["/news"].errors[0].code, "NO_FCP");
    assert.match(result.stdout, /baseline preserved/);
    assert.doesNotMatch(result.stdout, /all .* budgets met|baseline updated/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
