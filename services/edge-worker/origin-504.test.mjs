/**
 * Regression tests for the 2026-08-23 "24% of requests are 504" investigation.
 *
 * Two independent causes produced 44,875 × 504/day across the zone, and NEITHER
 * was a user-facing failure — both were synthetic requests that could never
 * have succeeded:
 *
 *  1. shorted.com.au (34,024/day): Cloudflare Early Hints probes. Fixed in
 *     terraform/modules/cloudflare-edge/main.tf by turning early_hints off;
 *     nothing in the worker to test.
 *
 *  2. api.shorted.com.au (10,851/day): OUR bug, covered here. The Cache API
 *     only accepts GET keys, so buildCacheKey() stores a POST RPC response
 *     under a synthesized GET (`?_cv=&_bh=`). We then advertised
 *     `stale-while-revalidate` on that entry, so Cloudflare revalidated it by
 *     fetching the synthesized GET — a body-less GET against a POST-only
 *     Connect handler, which never answers. 100% of those revalidations 504'd,
 *     and because they never succeeded, entries were served stale until
 *     eviction rather than refreshing.
 *
 * The two guarantees below are what keep it fixed.
 */
import assert from "node:assert/strict";
import test from "node:test";

import worker, { edgeCacheControl, isConnectRpcPath } from "./worker.js";

const RPC_PATH = "/shorts.v1alpha1.ShortedStocksService/GetStock";

// ---------------------------------------------------------------------------
// Guarantee 1: never advertise SWR on a POST-derived cache entry.
// ---------------------------------------------------------------------------

test("edgeCacheControl omits stale-while-revalidate for POST-derived entries", () => {
  const cc = edgeCacheControl("POST", 300);
  assert.equal(cc, "s-maxage=300");
  assert.ok(
    !cc.includes("stale-while-revalidate"),
    "SWR on a POST entry makes Cloudflare revalidate a synthesized GET that the " +
      "origin can never answer — this is the exact 10.8k/day 504 bug",
  );
});

test("edgeCacheControl keeps stale-while-revalidate for genuine GETs", () => {
  // A real GET key CAN be replayed, so SWR is both safe and valuable here.
  assert.equal(
    edgeCacheControl("GET", 300),
    "s-maxage=300, stale-while-revalidate=300",
  );
});

// ---------------------------------------------------------------------------
// Guarantee 2: a GET to a POST-only RPC path is answered at the edge.
// ---------------------------------------------------------------------------

test("isConnectRpcPath matches every Connect service namespace", () => {
  for (const p of [
    "/shorts.v1alpha1.ShortedStocksService/GetStock",
    "/shorts.v1alpha1.MarketService/GetTopShorts",
    "/marketdata.v1.MarketDataService/GetStockPrice",
    "/chat.v1.ChatService/SendMessage",
    "/register.v1.RegisterService/List",
  ]) {
    assert.ok(isConnectRpcPath(p), `${p} should be a Connect RPC path`);
  }
  for (const p of ["/health", "/api/cache/purge", "/v1/top", "/geo/states.topojson"]) {
    assert.ok(!isConnectRpcPath(p), `${p} must not be treated as an RPC path`);
  }
});

test("GET to a Connect RPC path returns 405 without touching origin", async () => {
  let originCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    originCalls += 1;
    return realFetch(...args);
  };

  try {
    const res = await worker.fetch(
      new Request(`https://api.shorted.com.au${RPC_PATH}?_cv=1&_bh=abc123`, {
        method: "GET",
      }),
      { SHORTS_API_ORIGIN: "https://origin.invalid" },
      { waitUntil() {} },
    );

    assert.equal(res.status, 405);
    assert.equal(res.headers.get("Allow"), "POST");
    assert.equal(
      originCalls,
      0,
      "the guard exists precisely so this request costs zero origin work",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("HEAD to a Connect RPC path is rejected the same way", async () => {
  const res = await worker.fetch(
    new Request(`https://api.shorted.com.au${RPC_PATH}`, { method: "HEAD" }),
    { SHORTS_API_ORIGIN: "https://origin.invalid" },
    { waitUntil() {} },
  );
  assert.equal(res.status, 405);
});

test("POST to a Connect RPC path is NOT caught by the guard", async () => {
  // The guard must be surgical: the real traffic on these paths is POST, and
  // breaking it would take the whole API down.
  let sawOrigin = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    sawOrigin = true;
    return new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const res = await worker.fetch(
      new Request(`https://api.shorted.com.au${RPC_PATH}`, {
        method: "POST",
        body: JSON.stringify({ productCode: "BHP" }),
        headers: { "Content-Type": "application/json" },
      }),
      { SHORTS_API_ORIGIN: "https://origin.invalid" },
      { waitUntil() {} },
    );

    assert.notEqual(res.status, 405);
    assert.ok(sawOrigin, "a POST RPC must still reach the origin");
  } finally {
    globalThis.fetch = realFetch;
  }
});
