import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { STOCK_ROUTES } from "../../web/scripts/route-kinds.mjs";

const script = fileURLToPath(new URL("../../web/scripts/route-kinds.mjs", import.meta.url));

// The stock routes that exist, read from the one registry of stock tabs instead of copied
// here. The registry is TypeScript and this job installs no web dependencies, so it is read
// as text: `segment: ""` is the Overview, any other segment is a tab folder. A registry the
// reader cannot follow fails loudly rather than yielding a short list.
function registryRoutes() {
  const text = readFileSync(new URL("../../web/src/@/lib/stocks/stock-tabs.ts", import.meta.url), "utf8");
  const array = /export const STOCK_TABS[^=]*=\s*\[([\s\S]*?)\n\];/.exec(text);
  assert.ok(array, "web/src/@/lib/stocks/stock-tabs.ts no longer declares STOCK_TABS as an array literal: update this reader");
  const entries = array[1].replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const ids = [...entries.matchAll(/\bid:\s*"[^"]*"/g)];
  const segments = [...entries.matchAll(/\bsegment:\s*"([^"]*)"/g)].map((m) => m[1]);
  assert.ok(
    ids.length > 0 && segments.length === ids.length,
    `STOCK_TABS has ${ids.length} tabs but ${segments.length} literal segments: this reader only sees \`segment: "..."\``,
  );
  return segments.map((segment) => (segment ? `/shorts/[stockCode]/${segment}` : "/shorts/[stockCode]"));
}

const EXPECTED = registryRoutes();

function run(t, manifest) {
  const dir = mkdtempSync(join(tmpdir(), "shorted-route-kinds-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "prerender-manifest.json");
  writeFileSync(path, JSON.stringify(manifest));
  return spawnSync(process.execPath, [script, "--manifest", path], { encoding: "utf8" });
}

// STOCK_ROUTES is what the gate checks; the registry is what exists. A tab added to one and
// not the other is either never gated or gated against a route that is not there, so the two
// are compared as sets. Order is the tab bar's business, not the gate's.
test("the gate checks exactly the stock tabs the registry declares", () => {
  assert.deepEqual(
    [...STOCK_ROUTES].sort(),
    [...EXPECTED].sort(),
    "STOCK_ROUTES in web/scripts/route-kinds.mjs has drifted from STOCK_TABS in web/src/@/lib/stocks/stock-tabs.ts: a tab missing from the gate's list is never checked for ISR",
  );
});

test("passes when every stock route is an ISR dynamic route", (t) => {
  const dynamicRoutes = Object.fromEntries(EXPECTED.map((r) => [r, { fallback: null, routeRegex: "x", dataRoute: "y" }]));
  const result = run(t, { version: 4, routes: {}, dynamicRoutes });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`${EXPECTED.length} stock routes are ISR`));
});

test("fails and names the route when one has slipped to per-request rendering", (t) => {
  const dynamicRoutes = Object.fromEntries(EXPECTED.filter((r) => !r.endsWith("/strategy")).map((r) => [r, { fallback: null }]));
  const result = run(t, { version: 4, routes: {}, dynamicRoutes });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\/shorts\/\[stockCode\]\/strategy/);
});

// Exit 2 is "the gate could not run", and CI must be able to tell it from 1, "a route slipped":
// the usual cause is a build that never wrote its manifest. A manifest that is there but is not
// JSON (a build killed mid-write) takes the same path. With no --manifest the gate reads
// .next/prerender-manifest.json from the working directory, which is how CI runs it.
test("exits 2, never 1, and says to build first when the manifest cannot be read", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "shorted-route-kinds-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const truncated = join(dir, "truncated.json");
  writeFileSync(truncated, '{ "version": 4, "dynamicRoutes": ');
  const attempts = [
    { args: ["--manifest", join(dir, "no-such-dir", "prerender-manifest.json")] },
    { args: ["--manifest", truncated] },
    { args: [], cwd: dir },
  ];
  for (const { args, cwd } of attempts) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", cwd });
    const label = `${args.join(" ") || "(default path)"}: ${result.stderr}`;
    assert.equal(result.status, 2, label);
    assert.match(result.stderr, /cannot read/, label);
    assert.match(result.stderr, /Run `next build` first/, label);
    assert.equal(result.stdout, "", "a gate that could not run must not claim a pass");
  }
});

// The gate cannot see a cookies()/headers()/searchParams/no-store read (its header says so), so
// its failure hint and its header send the reader to the Jest source scan that can. Keep that
// pointer true: the file it names must exist, and both places must still name it.
test("the failure hint and the header point at the source scan for dynamic-API reads", (t) => {
  const scan = "web/src/app/shorts/__tests__/isr-source-safety.test.ts";
  assert.ok(existsSync(new URL(`../../${scan}`, import.meta.url)), `${scan} is gone, but the gate points at it`);
  const result = run(t, { version: 4, routes: {}, dynamicRoutes: {} });
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(scan), `the failure hint does not name ${scan}`);
  const header = readFileSync(script, "utf8").split("\n").filter((line) => line.startsWith("//"));
  assert.ok(header.some((line) => line.includes(scan)), `the header comment does not name ${scan}`);
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
