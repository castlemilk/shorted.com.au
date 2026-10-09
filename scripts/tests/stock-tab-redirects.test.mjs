import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  legacyTabRedirects,
  stockTabRedirects,
} from "../../web/src/config/stock-tab-redirects.mjs";

// The repo-hygiene job runs this file and installs nothing under web/. So it
// imports only the dependency-free redirect module, and reads next.config.mjs
// as TEXT: importing that file pulls in @next/mdx, rehype-prism-plus and the
// env validator, which are not installed there.
const nextConfigSource = readFileSync(
  new URL("../../web/next.config.mjs", import.meta.url),
  "utf8",
);

// Written out by hand, not derived from the module under test. There is no
// `overview` key on purpose: a redirect from /shorts/:code to /shorts/:code
// sends ?tab=overview back to itself, because Next forwards the request's
// query string. ?tab=overview renders the Overview like any unmapped value.
const EXPECTED = {
  news: "news",
  timeline: "news",
  financials: "financials",
  dividends: "financials",
  directors: "company",
  peers: "short-interest",
  community: "community",
};

const isTabCondition = (condition) =>
  condition.type === "query" && condition.key === "tab";
const tabGated = legacyTabRedirects().filter((redirect) =>
  redirect.has?.some(isTabCondition),
);
const pathOf = (route) => route.split("?")[0].replace(/\/+$/, "");

test("the ?tab= map sends each legacy value to its tab segment", () => {
  assert.deepEqual(stockTabRedirects, EXPECTED);
});

test("each mapped value gets one permanent redirect, gated on ?tab= alone", () => {
  for (const [tab, segment] of Object.entries(EXPECTED)) {
    const matching = tabGated.filter((redirect) =>
      redirect.has.some((c) => isTabCondition(c) && c.value === tab),
    );
    assert.equal(
      matching.length,
      1,
      `?tab=${tab}: expected one redirect, found ${matching.length}`,
    );
    const [redirect] = matching;
    assert.equal(redirect.source, "/shorts/:code", `?tab=${tab}: source`);
    assert.equal(
      redirect.destination,
      `/shorts/:code/${segment}`,
      `?tab=${tab}: destination`,
    );
    assert.equal(redirect.permanent, true, `?tab=${tab}: permanent`);
    assert.equal(
      redirect.has.length,
      1,
      `?tab=${tab}: has a condition besides the tab query`,
    );
  }
});

test("no ?tab= redirect lands on its own path, so none can loop", () => {
  for (const redirect of tabGated) {
    assert.notEqual(
      pathOf(redirect.destination),
      pathOf(redirect.source),
      `${redirect.source} -> ${redirect.destination} lands on its own path. ` +
        "Next forwards the query string, so the tab condition matches again " +
        "and the redirect loops.",
    );
  }
});

// Next reads has.value as the regex source `^value$` (matchHas in
// next/dist/shared/lib/router/utils/prepare-destination.js), so a pattern such
// as ".*" or "news|foo" would also catch values the map does not name.
test("values outside the map match no ?tab= redirect", () => {
  for (const unmapped of ["foo", "overview"]) {
    for (const redirect of tabGated) {
      for (const condition of redirect.has.filter(isTabCondition)) {
        assert.equal(
          new RegExp(`^${condition.value}$`).test(unmapped),
          false,
          `has.value "${condition.value}" matches ?tab=${unmapped}`,
        );
      }
    }
  }
});

test("there is one ?tab= redirect per map entry", () => {
  assert.equal(
    tabGated.length,
    Object.keys(stockTabRedirects).length,
    "the number of tab-gated redirects differs from the map's key count",
  );
});

test("next.config.mjs source imports legacyTabRedirects() and spreads it in redirects()", () => {
  // Whole-line // comments are dropped so a mention in prose cannot satisfy the
  // checks. Block comments are left alone: the file's strings contain `/*`
  // and `*/` (CSP hosts, glob patterns), which a block-comment regex would
  // treat as comment delimiters and swallow real code.
  const code = nextConfigSource.replace(/^\s*\/\/.*$/gm, "");

  assert.match(
    code,
    /import\s*\{[^}]*\blegacyTabRedirects\b[^}]*\}\s*from\s*["']\.\/src\/config\/stock-tab-redirects\.mjs["']/,
    "next.config.mjs does not import legacyTabRedirects from ./src/config/stock-tab-redirects.mjs",
  );

  const start = code.indexOf("async redirects()");
  assert.notEqual(start, -1, "next.config.mjs has no redirects()");
  const afterHeader = code.slice(start + "async redirects()".length);
  const nextMethod = afterHeader.search(/\n\s*async\s+\w+\s*\(/);
  const body =
    nextMethod === -1 ? afterHeader : afterHeader.slice(0, nextMethod);
  assert.match(
    body,
    /\.\.\.\s*legacyTabRedirects\s*\(\s*\)/,
    "redirects() does not spread legacyTabRedirects()",
  );
});
