import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("../../web/scripts/route-kinds.mjs", import.meta.url));
const EXPECTED = [
  "/shorts/[stockCode]",
  "/shorts/[stockCode]/short-interest",
  "/shorts/[stockCode]/strategy",
  "/shorts/[stockCode]/financials",
  "/shorts/[stockCode]/company",
  "/shorts/[stockCode]/news",
  "/shorts/[stockCode]/community",
];

function run(t, manifest) {
  const dir = mkdtempSync(join(tmpdir(), "shorted-route-kinds-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "prerender-manifest.json");
  writeFileSync(path, JSON.stringify(manifest));
  return spawnSync(process.execPath, [script, "--manifest", path], { encoding: "utf8" });
}

test("passes when every stock route is an ISR dynamic route", (t) => {
  const dynamicRoutes = Object.fromEntries(EXPECTED.map((r) => [r, { fallback: null, routeRegex: "x", dataRoute: "y" }]));
  const result = run(t, { version: 4, routes: {}, dynamicRoutes });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /7 stock routes are ISR/);
});

test("fails and names the route when one has slipped to per-request rendering", (t) => {
  const dynamicRoutes = Object.fromEntries(EXPECTED.filter((r) => !r.endsWith("/strategy")).map((r) => [r, { fallback: null }]));
  const result = run(t, { version: 4, routes: {}, dynamicRoutes });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\/shorts\/\[stockCode\]\/strategy/);
});

// A gate that is skipped reads as a pass. Node resolves the entry module's
// symlinks for import.meta.url but leaves process.argv[1] as typed, and a
// path with a space is percent-encoded in the URL, so a naive "was I run
// directly?" comparison turns main() off and the script exits 0 having checked
// nothing. Neither shape is exotic: macOS /tmp is a symlink.
test("still runs, and fails, when reached through a symlink or a path with a space", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "shorted-route-kinds-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const spaced = join(dir, "a b");
  mkdirSync(spaced);
  copyFileSync(script, join(spaced, "route-kinds.mjs"));
  symlinkSync(spaced, join(dir, "link"), "dir");
  const manifest = join(dir, "prerender-manifest.json");
  writeFileSync(manifest, JSON.stringify({ version: 4, routes: {}, dynamicRoutes: {} }));
  for (const entry of [join(spaced, "route-kinds.mjs"), join(dir, "link", "route-kinds.mjs")]) {
    const result = spawnSync(process.execPath, [entry, "--manifest", manifest], { encoding: "utf8" });
    assert.equal(result.status, 1, `${entry}: the gate must run and fail, not exit ${result.status} unchecked`);
    assert.match(result.stderr, /\/shorts\/\[stockCode\]/);
  }
});

test("the CI workflow and the npm script run it after the bundle budget", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/perf-budget.yml", import.meta.url), "utf8");
  assert.match(workflow, /node scripts\/route-kinds\.mjs/);
  assert.ok(workflow.indexOf("route-kinds.mjs") > workflow.indexOf("bundle-budget.mjs"), "route kinds runs after the bundle budget");
  const pkg = JSON.parse(readFileSync(new URL("../../web/package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts["routes:kinds"], "node scripts/route-kinds.mjs");
});
