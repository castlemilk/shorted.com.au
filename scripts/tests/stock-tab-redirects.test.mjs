import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

process.env.SKIP_ENV_VALIDATION = "1";
const configUrl = new URL("../../web/next.config.mjs", import.meta.url);
const mapUrl = new URL("../../web/src/config/stock-tab-redirects.json", import.meta.url);

const EXPECTED = {
  overview: "",
  news: "news",
  timeline: "news",
  financials: "financials",
  dividends: "financials",
  directors: "company",
  peers: "short-interest",
  community: "community",
};

test("the legacy ?tab= map names every old tab exactly once", () => {
  const map = JSON.parse(readFileSync(mapUrl, "utf8"));
  assert.deepEqual(map, EXPECTED);
});

test("next.config emits one permanent, query-matched redirect per legacy tab", async () => {
  const { default: config } = await import(configUrl.href);
  const redirects = await config.redirects();
  for (const [tab, segment] of Object.entries(EXPECTED)) {
    const entry = redirects.find(
      (r) => r.source === "/shorts/:code" && r.has?.some((h) => h.type === "query" && h.key === "tab" && h.value === tab),
    );
    assert.ok(entry, `missing redirect for ?tab=${tab}`);
    assert.equal(entry.permanent, true);
    assert.equal(entry.destination, segment ? `/shorts/:code/${segment}` : "/shorts/:code");
    assert.equal(entry.has.length, 1, "exactly one query condition, so ?tab=foo never matches");
  }
});

test("an unmapped tab value has no redirect, so it cannot loop", async () => {
  const { default: config } = await import(configUrl.href);
  const redirects = await config.redirects();
  assert.equal(
    redirects.some((r) => r.has?.some((h) => h.key === "tab" && h.value === "foo")),
    false,
  );
});
