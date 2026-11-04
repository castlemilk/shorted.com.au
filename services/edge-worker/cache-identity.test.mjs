import assert from "node:assert/strict";
import test from "node:test";

import worker, {
  buildKvCacheKey,
  isCacheableRpc,
  isKvCacheableEndpoint,
  isPublicReadEndpoint,
  resolvePublicEdgeReadRoute,
} from "./worker.js";
import { PREWARM_ENDPOINTS, buildKvKey } from "./prewarm.js";

const API = "https://api.shorted.com.au";
const ORIGIN = "https://shorts-origin.test";
const SHORTS = "/shorts.v1alpha1.ShortedStocksService";
const KV_PREFIX = "prewarm:";

// A 32-bit, non-cryptographic reference hash. It is used only to choose two
// request bodies that share a value, so the test can prove a shared value
// does not share an entry.
function shortHash(text) {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Runs `fn` with a fake origin, a fake Cache API and a fake KV namespace, and
 * records every origin call, cache write and KV access. `originReply` builds the
 * origin response from the call's record and its ordinal.
 */
async function withEdge(originReply, fn) {
  const saved = { fetch: globalThis.fetch, caches: globalThis.caches };
  const state = {
    originCalls: [],
    cacheStore: new Map(),
    cacheWrites: [],
    kvStore: new Map(),
    kvReads: [],
    kvWrites: [],
    pending: [],
  };

  globalThis.caches = {
    default: {
      async match(request) {
        const hit = state.cacheStore.get(request.url);
        return hit ? hit.clone() : undefined;
      },
      async put(request, response) {
        state.cacheWrites.push(request.url);
        state.cacheStore.set(request.url, response.clone());
      },
    },
  };
  globalThis.fetch = async (url, init) => {
    const call = {
      url: String(url),
      method: init?.method,
      body: init?.body ? new TextDecoder().decode(init.body) : "",
    };
    state.originCalls.push(call);
    return originReply(call, state.originCalls.length);
  };

  const env = {
    SHORTS_API_ORIGIN: ORIGIN,
    MARKET_DATA_ORIGIN: "https://market-origin.test",
    EDGE_ANALYTICS_SAMPLE_RATE: "0",
    EDGE_KV: {
      async get(key) {
        state.kvReads.push(key);
        return state.kvStore.get(key) ?? null;
      },
      async put(key, value) {
        state.kvWrites.push(key);
        state.kvStore.set(key, value);
      },
    },
  };
  const ctx = {
    waitUntil(promise) {
      state.pending.push(Promise.resolve(promise));
    },
  };

  try {
    // Background cache and KV writes are flushed before each response is
    // inspected, so assertions see what a real request would have stored.
    const send = async (request) => {
      const response = await worker.fetch(request, env, ctx);
      await Promise.all(state.pending);
      return response;
    };
    return await fn({ env, ctx, state, send });
  } finally {
    await Promise.all(state.pending);
    globalThis.fetch = saved.fetch;
    if (saved.caches === undefined) delete globalThis.caches;
    else globalThis.caches = saved.caches;
  }
}

function jsonOrigin(call, ordinal) {
  return new Response(JSON.stringify({ call: ordinal, echoed: call.body }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function rpc(path, body, headers = {}) {
  return new Request(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

const probeBody = JSON.stringify({ item: "probe" });

function isPrewarmKey(key) {
  return typeof key === "string" && key.startsWith(KV_PREFIX);
}

test("non-allowlisted paths pass through every tier, whatever headers they carry", async () => {
  const path = "/shorts.v1alpha1.ExampleService/UpdateExample";
  const body = JSON.stringify({ item: "same-body" });
  const credentialed = [
    {},
    { Authorization: "Bearer example-token" },
    { "x-user-id": "user-1" },
    { "x-internal-secret": "example-secret" },
  ];

  await withEdge(jsonOrigin, async ({ send, state }) => {
    for (const [index, headers] of credentialed.entries()) {
      const response = await send(rpc(path, body, headers));
      assert.equal(response.headers.get("X-Shorted-Cache"), "BYPASS");
      assert.deepEqual(await response.json(), {
        call: index + 1,
        echoed: body,
      });
    }

    assert.equal(state.originCalls.length, credentialed.length);
    assert.deepEqual(state.cacheWrites, []);
    assert.deepEqual(state.kvWrites, []);
    assert.deepEqual(state.kvReads.filter(isPrewarmKey), []);
  });
});

test("a repeated identical mutation reaches the origin every time", async () => {
  const path = "/shorts.v1alpha1.ExampleService/CreateExample";
  const body = JSON.stringify({ name: "example" });

  await withEdge(jsonOrigin, async ({ send, state }) => {
    for (let i = 1; i <= 3; i++) {
      const response = await send(rpc(path, body));
      assert.equal((await response.json()).call, i);
    }
    assert.equal(state.originCalls.length, 3);
    assert.deepEqual(state.cacheWrites, []);
    assert.deepEqual(state.kvWrites, []);
  });
});

test("allowlisted reads share one entry across callers", async () => {
  const path = `${SHORTS}/GetStock`;
  const body = JSON.stringify({ product_code: "SHR1" });

  await withEdge(jsonOrigin, async ({ send, state }) => {
    const first = await send(rpc(path, body, { Authorization: "Bearer caller-a", "x-user-id": "u1" }));
    assert.equal(first.headers.get("X-Shorted-Cache"), "MISS");
    const firstBody = await first.text();

    const anonymous = await send(rpc(path, body));
    assert.equal(anonymous.headers.get("X-Shorted-Cache"), "HOT");
    assert.equal(await anonymous.text(), firstBody);

    const internal = await send(rpc(path, body, { "x-internal-secret": "example-secret" }));
    assert.equal(internal.headers.get("X-Shorted-Cache"), "HOT");
    assert.equal(await internal.text(), firstBody);

    assert.equal(state.originCalls.length, 1);
  });
});

test("a KV-cacheable read is stored under a SHA-256 body key", async () => {
  const path = `${SHORTS}/GetStockData`;
  const body = JSON.stringify({ product_code: "KVX1", period: "3m" });

  await withEdge(jsonOrigin, async ({ send, state }) => {
    const response = await send(rpc(path, body));
    assert.equal(response.headers.get("X-Shorted-Cache"), "MISS");

    const expected = `${KV_PREFIX}v1:shorts.v1alpha1.ShortedStocksService_GetStockData:${await sha256Hex(body)}`;
    assert.ok(state.kvWrites.includes(expected), `expected KV write ${expected}`);
  });
});

test("two bodies that share a 32-bit hash keep separate hot and KV entries", async () => {
  const path = `${SHORTS}/GetStock`;
  const first = JSON.stringify({ product_code: "00000r" });
  const second = JSON.stringify({ product_code: "000020" });
  assert.notEqual(first, second);
  assert.equal(shortHash(first), shortHash(second));

  await withEdge(jsonOrigin, async ({ send, state }) => {
    const one = await send(rpc(path, first));
    assert.equal(one.headers.get("X-Shorted-Cache"), "MISS");
    assert.equal((await one.json()).echoed, first);

    const two = await send(rpc(path, second));
    assert.equal(two.headers.get("X-Shorted-Cache"), "MISS");
    assert.equal((await two.json()).echoed, second);

    assert.equal(state.originCalls.length, 2);
    assert.equal(new Set(state.kvWrites).size, 2);
  });
});

test("allowlisting is anchored to the full service and method", () => {
  const nearMisses = [
    `${SHORTS}/GetStockPricesHistory`,
    `${SHORTS}/GetStockAlerts`,
    `${SHORTS}/GetStock/extra`,
    `/prefix${SHORTS}/GetStock`,
    `/shorts.v1alpha1.ExampleService/GetStock`,
    `${SHORTS}/GetStockNewsDigest`,
    `/marketdata.v1.MarketDataService/GetExampleOnly`,
    `${SHORTS}/GetViewerExample`,
  ];
  for (const path of nearMisses) {
    assert.equal(isPublicReadEndpoint(path), false, path);
    assert.equal(isCacheableRpc(rpc(path, probeBody), path), false, path);
  }

  const allowed = [
    `${SHORTS}/GetStock`,
    "/shorts.v1alpha1.StockService/GetStock",
    "/marketdata.v1.MarketDataService/GetStockCorrelations",
  ];
  for (const path of allowed) {
    assert.equal(isPublicReadEndpoint(path), true, path);
  }
});

test("only POST reaches a cache tier, and only for an allowlisted read", () => {
  const path = `${SHORTS}/GetStock`;
  assert.equal(isCacheableRpc(rpc(path, probeBody), path), true);
  assert.equal(isCacheableRpc(new Request(`${API}${path}`, { method: "GET" }), path), false);
  assert.equal(isCacheableRpc(rpc("/shorts.v1alpha1.ExampleService/Anything", probeBody), "/shorts.v1alpha1.ExampleService/Anything"), false);
});

test("every KV-cached path is allowlisted", async () => {
  const services = [
    "shorts.v1alpha1.ShortedStocksService",
    "shorts.v1alpha1.StockService",
    "shorts.v1alpha1.NewsService",
    "shorts.v1alpha1.MarketService",
    "shorts.v1alpha1.ReportsService",
    "shorts.v1alpha1.IndustryIntelligenceService",
    "shorts.v1alpha1.ExampleService",
    "marketdata.v1.MarketDataService",
  ];
  const methods = [
    "GetTopShorts", "GetIndustryTreeMap", "GetIndustryIntelligence", "GetShortsTreeMap",
    "GetWeeklyReport", "GetAvailableDates", "GetMarketByDate", "GetStock", "GetStockDetails",
    "GetStockData", "GetStockPrices", "GetStockNews", "GetStockFinancialHighlights", "GetNews",
    "GetAnnouncement", "GetMarketNews", "GetStockPrice", "GetMultipleStockPrices",
    "GetHistoricalPrices", "GetDirectorTrades", "GetExampleOnly",
  ];

  let kvCacheable = 0;
  for (const service of services) {
    for (const method of methods) {
      const path = `/${service}/${method}`;
      if (isKvCacheableEndpoint(path)) {
        kvCacheable++;
        assert.equal(isPublicReadEndpoint(path), true, path);
      }
      const key = await buildKvCacheKey(rpc(path, probeBody), path, "v1");
      if (key !== null) assert.equal(isPublicReadEndpoint(path), true, path);
    }
  }
  assert.ok(kvCacheable > 0);
});

test("every prewarmed endpoint is allowlisted and writes the key the worker reads", async () => {
  for (const endpoint of PREWARM_ENDPOINTS) {
    assert.equal(isPublicReadEndpoint(endpoint.path), true, endpoint.path);
    assert.equal(isKvCacheableEndpoint(endpoint.path), true, endpoint.path);

    const written = await buildKvKey(endpoint, "v1");
    const read = await buildKvCacheKey(
      rpc(endpoint.path, JSON.stringify(endpoint.body)),
      endpoint.path,
      "v1",
    );
    assert.equal(written, read, endpoint.path);
  }
});

test("every public edge read resolves to an allowlisted path", () => {
  const reads = [
    "/edge/v1/top-shorts?period=3m&limit=10",
    "/edge/v1/industry-treemap?period=3m",
    "/edge/v1/available-dates",
    "/edge/v1/market-by-date?date=2026-10-01",
    "/edge/v1/weekly-report?period=1w",
    "/edge/v1/news?limit=5",
    "/edge/v1/announcements?limit=5",
    "/edge/v1/news/market?limit=5",
    "/edge/v1/stock/BHP",
    "/edge/v1/stock/BHP/details",
    "/edge/v1/stock/BHP/data?period=3m",
    "/edge/v1/stock/BHP/news?limit=5",
    "/edge/v1/market/stock/BHP/price",
    "/edge/v1/market/stock/BHP/history?period=3m",
    "/edge/v1/market/stocks/prices?codes=BHP,CBA",
  ];
  for (const read of reads) {
    const route = resolvePublicEdgeReadRoute(new URL(`${API}${read}`));
    assert.ok(route, read);
    const request = rpc(route.path, JSON.stringify(route.body));
    assert.equal(isCacheableRpc(request, route.path), true, route.path);
  }
});
