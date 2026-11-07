import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { strategyRedirects } from "../../web/src/config/strategy-redirects.mjs";

// The repo-hygiene job runs this file and installs nothing under web/, so it
// imports only the dependency-free redirect module and reads next.config.mjs as
// text (importing it pulls in @next/mdx and the env validator).
const nextConfigSource = readFileSync(
  new URL("../../web/next.config.mjs", import.meta.url),
  "utf8",
);

// Next matches `:path*` as a path-to-regexp wildcard. This is the same shape
// for the two sources the module emits, written out so the test does not
// depend on the matcher it is checking: `/picks` exactly, and `/picks/` with
// anything after it.
function matches(source, path) {
  if (source === "/picks") return path === "/picks";
  if (source === "/picks/:path*") return path === "/picks" || path.startsWith("/picks/");
  throw new Error(`unexpected source ${source}`);
}

function destinationFor(redirect, path) {
  const rest = path.replace(/^\/picks/, "");
  return redirect.destination.replace(":path*", rest.replace(/^\//, ""))
    .replace(/\/$/, "");
}

const redirects = strategyRedirects();

test("the module emits exactly the two /picks rules, both permanent", () => {
  assert.deepEqual(redirects, [
    { source: "/picks", destination: "/strategies", permanent: true },
    { source: "/picks/:path*", destination: "/strategies/:path*", permanent: true },
  ]);
});

test("the current /picks URLs all land on their /strategies counterpart", () => {
  const cases = [
    ["/picks", "/strategies"],
    ["/picks/zanger-breakout", "/strategies/zanger-breakout"],
    ["/picks/canslim", "/strategies/canslim"],
    ["/picks/minervini-trend-template", "/strategies/minervini-trend-template"],
    ["/picks/crowded-short-breakout", "/strategies/crowded-short-breakout"],
    ["/picks/quality-compounders", "/strategies/quality-compounders"],
    ["/picks/opengraph-image", "/strategies/opengraph-image"],
    ["/picks/canslim/opengraph-image", "/strategies/canslim/opengraph-image"],
  ];
  for (const [from, to] of cases) {
    const hit = redirects.find((r) => matches(r.source, from));
    assert.ok(hit, `${from} matches no /picks redirect`);
    assert.equal(destinationFor(hit, from), to, `${from}`);
  }
});

test("no redirect lands on its own source, so none can loop", () => {
  for (const redirect of redirects) {
    const sampleDestination = redirect.destination.replace(":path*", "x");
    assert.equal(
      matches(redirect.source, sampleDestination),
      false,
      `${redirect.source} -> ${redirect.destination} matches its own source`,
    );
  }
});

test("/picks-art assets and /strategies routes are not redirected", () => {
  for (const path of [
    "/picks-art/zanger-breakout.light.avif",
    "/picks-art/og/canslim.jpg",
    "/strategies",
    "/strategies/canslim",
    "/strategies/minervini-trend-template",
  ]) {
    assert.equal(
      redirects.some((r) => matches(r.source, path)),
      false,
      `${path} matches a /picks redirect`,
    );
  }
});

test("next.config.mjs imports strategyRedirects() and spreads it in redirects()", () => {
  // Whole-line // comments are dropped so prose cannot satisfy the checks.
  const code = nextConfigSource.replace(/^\s*\/\/.*$/gm, "");
  assert.match(
    code,
    /import\s*\{[^}]*\bstrategyRedirects\b[^}]*\}\s*from\s*["']\.\/src\/config\/strategy-redirects\.mjs["']/,
    "next.config.mjs does not import strategyRedirects from ./src/config/strategy-redirects.mjs",
  );
  const start = code.indexOf("async redirects()");
  assert.notEqual(start, -1, "next.config.mjs has no redirects()");
  const afterHeader = code.slice(start + "async redirects()".length);
  const nextMethod = afterHeader.search(/\n\s*async\s+\w+\s*\(/);
  const body = nextMethod === -1 ? afterHeader : afterHeader.slice(0, nextMethod);
  assert.match(
    body,
    /\.\.\.\s*strategyRedirects\s*\(\s*\)/,
    "redirects() does not spread strategyRedirects()",
  );
});
