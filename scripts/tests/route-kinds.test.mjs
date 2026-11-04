import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { OWNERSHIP_ROUTES, OWNERSHIP_STATIC_ROUTES, STOCK_ROUTES } from "../../web/scripts/route-kinds.mjs";

const script = fileURLToPath(new URL("../../web/scripts/route-kinds.mjs", import.meta.url));
const OWNERSHIP_DIR = fileURLToPath(new URL("../../web/src/app/ownership/", import.meta.url));

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

// The same drift check for the ownership section: a page the gate does not list is never checked
// for ISR, so the routes are read from the tree rather than restated here. A __tests__ folder
// holds no page. A page.tsx under a dynamic segment is a dynamic route, and any other is static.
function ownershipPageRoutes(dir = OWNERSHIP_DIR, prefix = "/ownership") {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      if (entry.isDirectory()) {
        return entry.name === "__tests__" ? [] : ownershipPageRoutes(join(dir, entry.name), `${prefix}/${entry.name}`);
      }
      return entry.name === "page.tsx" ? [prefix] : [];
    })
    .sort();
}

function dynamicOwnershipRoutes() {
  return ownershipPageRoutes().filter((route) => route.includes("["));
}

// Every page without a dynamic segment, the hub included: the gate lists each one under `routes`.
function staticOwnershipRoutes() {
  return ownershipPageRoutes().filter((route) => !route.includes("["));
}

function run(t, manifest) {
  const dir = mkdtempSync(join(tmpdir(), "shorted-route-kinds-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "prerender-manifest.json");
  writeFileSync(path, JSON.stringify(manifest));
  return spawnSync(process.execPath, [script, "--manifest", path], { encoding: "utf8" });
}

// The static ownership pages as Next writes them under `routes`: each with the revalidate it exports.
function staticRoutes() {
  return Object.fromEntries(
    OWNERSHIP_STATIC_ROUTES.map((route) => [
      route,
      { initialRevalidateSeconds: 3600, srcRoute: route, dataRoute: `${route}.rsc` },
    ]),
  );
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

test("the gate checks exactly the dynamic ownership pages on disk", () => {
  assert.deepEqual(
    [...OWNERSHIP_ROUTES].sort(),
    dynamicOwnershipRoutes(),
    "OWNERSHIP_ROUTES in web/scripts/route-kinds.mjs has drifted from the dynamic pages under web/src/app/ownership: a dynamic ownership page missing from the gate's list is never checked for ISR",
  );
});

test("the gate checks exactly the static ownership pages on disk, the hub included", () => {
  assert.deepEqual(
    [...OWNERSHIP_STATIC_ROUTES].sort(),
    staticOwnershipRoutes(),
    "OWNERSHIP_STATIC_ROUTES in web/scripts/route-kinds.mjs has drifted from the static pages under web/src/app/ownership: a static ownership page missing from the gate's list is never checked for ISR",
  );
});

test("passes when every stock and dynamic ownership route is listed and every static ownership page has a revalidate", (t) => {
  const routes = [...EXPECTED, ...OWNERSHIP_ROUTES];
  const dynamicRoutes = Object.fromEntries(routes.map((r) => [r, { fallback: null, routeRegex: "x", dataRoute: "y" }]));
  const result = run(t, { version: 4, routes: staticRoutes(), dynamicRoutes });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`${EXPECTED.length} stock routes are ISR`));
  assert.match(result.stdout, new RegExp(`${OWNERSHIP_ROUTES.length} ownership routes are ISR`));
  assert.match(result.stdout, new RegExp(`${OWNERSHIP_STATIC_ROUTES.length} static ownership routes are ISR`));
});

// Only the stock check can supply the exit 1 here: every ownership check gets the routes it needs,
// so the stdout lines below show them passing.
test("fails and names the route when one has slipped to per-request rendering", (t) => {
  const kept = EXPECTED.filter((r) => !r.endsWith("/strategy"));
  const dynamicRoutes = Object.fromEntries([...kept, ...OWNERSHIP_ROUTES].map((r) => [r, { fallback: null }]));
  const result = run(t, { version: 4, routes: staticRoutes(), dynamicRoutes });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\/shorts\/\[stockCode\]\/strategy/);
  assert.match(result.stdout, new RegExp(`${OWNERSHIP_ROUTES.length} ownership routes are ISR`));
  assert.match(result.stdout, new RegExp(`${OWNERSHIP_STATIC_ROUTES.length} static ownership routes are ISR`));
});

test("fails and names the ownership route when one has slipped to per-request rendering", (t) => {
  const kept = OWNERSHIP_ROUTES.filter((r) => r !== "/ownership/stocks/[code]");
  const dynamicRoutes = Object.fromEntries([...EXPECTED, ...kept].map((r) => [r, { fallback: null }]));
  const result = run(t, { version: 4, routes: staticRoutes(), dynamicRoutes });
  assert.equal(result.status, 1);
  // The stock and static routes are all present, so only the dynamic ownership check fails.
  assert.match(result.stdout, new RegExp(`${EXPECTED.length} stock routes are ISR`));
  assert.match(result.stdout, new RegExp(`${OWNERSHIP_STATIC_ROUTES.length} static ownership routes are ISR`));
  assert.match(result.stderr, /\/ownership\/stocks\/\[code\]/);
});

// A static page is ISR only as `routes` lists it with its revalidate. Each way of losing that is
// its own case: an export of false (no revalidate), no entry at all, and a listing under dynamicRoutes.
// Every static page is tried, the hub included, since each one is listed in the manifest on its own.
test("fails and names each static ownership page when the manifest does not list it as ISR", (t) => {
  const dynamicRoutes = Object.fromEntries([...EXPECTED, ...OWNERSHIP_ROUTES].map((r) => [r, { fallback: null }]));
  for (const route of OWNERSHIP_STATIC_ROUTES) {
    const withoutRoute = Object.fromEntries(Object.entries(staticRoutes()).filter(([r]) => r !== route));
    const cases = [
      [
        "has no revalidate",
        { ...staticRoutes(), [route]: { initialRevalidateSeconds: false, srcRoute: route } },
        dynamicRoutes,
      ],
      ["is missing from routes", withoutRoute, dynamicRoutes],
      ["is listed under dynamicRoutes", staticRoutes(), { ...dynamicRoutes, [route]: { fallback: null } }],
    ];
    for (const [how, routes, dynamic] of cases) {
      const result = run(t, { version: 4, routes, dynamicRoutes: dynamic });
      assert.equal(result.status, 1, `${route} ${how}: the gate must fail`);
      // The dynamic checks pass in every case, so the static one is the only failure.
      assert.match(result.stdout, new RegExp(`${OWNERSHIP_ROUTES.length} ownership routes are ISR`), how);
      const lines = result.stderr.split("\n");
      assert.ok(
        lines.includes(`  ${route}`),
        `${route} ${how}: the failure does not name it on its own line`,
      );
      // Only the page that slipped is named. A gate that named every static page whenever one slipped
      // would pass every check above and send the reader to the other two.
      for (const other of OWNERSHIP_STATIC_ROUTES.filter((r) => r !== route)) {
        assert.ok(!lines.includes(`  ${other}`), `${route} ${how}: ${other} is named too, though it did not slip`);
      }
    }
  }
});

// Every list is checked before the verdict: a build that slips on several names every route it lost,
// and prints no pass line, so one CI round finds them all.
test("names the stock, ownership and static ownership routes together when all have slipped", (t) => {
  const result = run(t, { version: 4, routes: {}, dynamicRoutes: {} });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, "", "a failing gate prints no pass line");
  // Each missing route is printed alone on an indented line, so the whole line is compared.
  const lines = result.stderr.split("\n");
  for (const route of [...EXPECTED, ...OWNERSHIP_ROUTES, ...OWNERSHIP_STATIC_ROUTES]) {
    assert.ok(lines.includes(`  ${route}`), `${route} is missing from the failure, so a second CI round would be needed to find it`);
  }
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

// The static block prints the same path, so the static pages get routes that pass here. The dynamic
// block is then the only place the path can come from.
test("the ownership failure hint and the header point at the ownership source scan", (t) => {
  const scan = "web/src/app/ownership/__tests__/isr-source-safety.test.ts";
  assert.ok(existsSync(new URL(`../../${scan}`, import.meta.url)), `${scan} is gone, but the gate points at it`);
  const dynamicRoutes = Object.fromEntries(EXPECTED.map((r) => [r, { fallback: null }]));
  const result = run(t, { version: 4, routes: staticRoutes(), dynamicRoutes });
  assert.equal(result.status, 1);
  assert.match(result.stdout, new RegExp(`${OWNERSHIP_STATIC_ROUTES.length} static ownership routes are ISR`));
  assert.ok(result.stderr.includes(scan), `the ownership failure hint does not name ${scan}`);
  const header = readFileSync(script, "utf8").split("\n").filter((line) => line.startsWith("//"));
  assert.ok(header.some((line) => line.includes(scan)), `the header comment does not name ${scan}`);
});

// Only the static check fails in this case, so the assertions below read its hint. The hint names
// the static ownership pages, both ways a page loses ISR (built once and never regenerated, or
// rendered per request), and the ownership source scan, which sees such a read in a file under
// app/ownership.
test("the static failure hint names the static ownership pages, both outcomes and the ownership source scan", (t) => {
  const scan = "web/src/app/ownership/__tests__/isr-source-safety.test.ts";
  assert.ok(existsSync(new URL(`../../${scan}`, import.meta.url)), `${scan} is gone, but the gate points at it`);
  const dynamicRoutes = Object.fromEntries([...EXPECTED, ...OWNERSHIP_ROUTES].map((r) => [r, { fallback: null }]));
  const result = run(t, { version: 4, routes: {}, dynamicRoutes });
  assert.equal(result.status, 1, result.stderr);
  // The stock and dynamic ownership routes pass, so the static check is the one that fails.
  assert.match(result.stdout, new RegExp(`${EXPECTED.length} stock routes are ISR`));
  assert.match(result.stdout, new RegExp(`${OWNERSHIP_ROUTES.length} ownership routes are ISR`));
  assert.ok(
    result.stderr.includes("under /ownership (the hub, the notice feed, the register list, the insights explorer or a workspace page)"),
    "the static failure hint does not name the static ownership pages",
  );
  // Each outcome is matched to its own cause, so a swap of the two parentheticals fails here.
  assert.match(
    result.stderr,
    /lost its `export const revalidate` \(Next then builds it once and never regenerates it\)/,
    "the static failure hint lost the no-revalidate outcome, or pairs it with the wrong cause",
  );
  assert.match(
    result.stderr,
    /during its build render \(Next then renders it per request\)/,
    "the static failure hint lost the request-time outcome, or pairs it with the wrong cause",
  );
  assert.ok(result.stderr.includes(scan), `the static failure hint does not name ${scan}`);
});

// The static header cites the isr-hubs check of each static page's own file. Pinned as the scan
// pointers are: the file must exist, and the header must name it.
test("the static header points at the isr-hubs check of each static page's own file", () => {
  const hubs = "web/src/app/__tests__/isr-hubs.test.ts";
  assert.ok(existsSync(new URL(`../../${hubs}`, import.meta.url)), `${hubs} is gone, but the gate points at it`);
  const header = readFileSync(script, "utf8").split("\n").filter((line) => line.startsWith("//"));
  assert.ok(header.some((line) => line.includes(hubs)), `the header comment does not name ${hubs}`);
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
