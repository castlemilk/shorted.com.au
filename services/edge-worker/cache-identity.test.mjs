import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import worker, {
  buildKvCacheKey,
  isCacheableRpc,
  isKvCacheableEndpoint,
  isPublicReadEndpoint,
  publicReadPaths,
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

test("an ownership read shares one entry across callers and keeps feed pages apart", async () => {
  // OwnershipService's fourteen reads (and their ShortedStocksService mirrors) are
  // read-only and caller-invariant: each assembles its answer from the one universe
  // the API caches, and none reads a caller. A feed page's cursor is in the body.
  const path = "/shorts.v1alpha1.OwnershipService/ListSubstantialNotices";
  const first = JSON.stringify({ window: 30, limit: 50 });
  const second = JSON.stringify({ window: 30, limit: 50, cursor: "2026-10-01|https://x/1.pdf" });

  await withEdge(jsonOrigin, async ({ send, state }) => {
    const a = await send(rpc(path, first, { Authorization: "Bearer caller-a" }));
    assert.equal(a.headers.get("X-Shorted-Cache"), "MISS");
    const b = await send(rpc(path, first));
    assert.equal(b.headers.get("X-Shorted-Cache"), "HOT");
    assert.equal(await b.text(), await a.text());
    const c = await send(rpc(path, second));
    assert.equal(c.headers.get("X-Shorted-Cache"), "MISS");
    assert.equal(state.originCalls.length, 2);
  });
  for (const service of ["OwnershipService", "ShortedStocksService"]) {
    assert.equal(isPublicReadEndpoint(`/shorts.v1alpha1.${service}/GetStockOwnership`), true);
    assert.equal(isPublicReadEndpoint(`/shorts.v1alpha1.${service}/GetStockOwnershipHistory`), false);
  }
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

test("only a JSON body reaches a cache tier", () => {
  const path = `${SHORTS}/GetStock`;
  const withType = (type) => new Request(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": type },
    body: probeBody,
  });
  assert.equal(isCacheableRpc(withType("application/json"), path), true);
  assert.equal(isCacheableRpc(withType("application/json; charset=utf-8"), path), true);
  assert.equal(isCacheableRpc(withType("Application/JSON"), path), true);
  assert.equal(isCacheableRpc(withType("application/proto"), path), false);
  assert.equal(isCacheableRpc(withType("application/connect+json"), path), false);
  assert.equal(isCacheableRpc(withType("text/plain;charset=UTF-8"), path), false);
});

test("a non-JSON request to an allowlisted read passes through every tier uncached", async () => {
  const path = `${SHORTS}/GetTopShorts`;
  // Two distinct binary request bodies.
  const bodies = [new Uint8Array([0x10, 0xc8, 0x01]), new Uint8Array([0x10, 0xc9, 0x01])];

  await withEdge(jsonOrigin, async ({ send, state }) => {
    for (const [index, bytes] of bodies.entries()) {
      const response = await send(new Request(`${API}${path}`, {
        method: "POST",
        headers: { "content-type": "application/proto" },
        body: bytes,
      }));
      assert.equal(response.headers.get("X-Shorted-Cache"), "BYPASS");
      assert.equal((await response.json()).call, index + 1);
    }
    assert.equal(state.originCalls.length, bodies.length);
    assert.deepEqual(state.cacheWrites, []);
    assert.deepEqual(state.kvWrites, []);
  });
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
    "GetTopShorts", "GetIndustryTreeMap", "GetIndustryIntelligence",
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

// The reviewed allowlist. Changing PUBLIC_READ_RPCS in worker.js means
// changing this list in the same commit, where a reviewer sees both.
const REVIEWED_PUBLIC_READS = [
  "/marketdata.v1.MarketDataService/GetHistoricalPrices",
  "/marketdata.v1.MarketDataService/GetMultipleStockPrices",
  "/marketdata.v1.MarketDataService/GetStockCorrelations",
  "/marketdata.v1.MarketDataService/GetStockPrice",
  "/shorts.v1alpha1.IndustryIntelligenceService/GetIndustryIntelligence",
  "/shorts.v1alpha1.MarketService/GetAvailableDates",
  "/shorts.v1alpha1.MarketService/GetIndustryTreeMap",
  "/shorts.v1alpha1.MarketService/GetMarketByDate",
  "/shorts.v1alpha1.MarketService/GetTopShorts",
  "/shorts.v1alpha1.NewsService/GetMarketNews",
  "/shorts.v1alpha1.NewsService/GetStockNews",
  "/shorts.v1alpha1.OwnershipService/CompareFundSnapshots",
  "/shorts.v1alpha1.OwnershipService/GetFundPortfolio",
  "/shorts.v1alpha1.OwnershipService/GetInstitution",
  "/shorts.v1alpha1.OwnershipService/GetOwnershipActivity",
  "/shorts.v1alpha1.OwnershipService/GetOwnershipFlows",
  "/shorts.v1alpha1.OwnershipService/GetOwnershipMap",
  "/shorts.v1alpha1.OwnershipService/GetOwnershipOverview",
  "/shorts.v1alpha1.OwnershipService/GetStockFundSeries",
  "/shorts.v1alpha1.OwnershipService/GetStockOwnership",
  "/shorts.v1alpha1.OwnershipService/ListFundPositionChanges",
  "/shorts.v1alpha1.OwnershipService/ListFunds",
  "/shorts.v1alpha1.OwnershipService/ListInstitutions",
  "/shorts.v1alpha1.OwnershipService/ListStockRegisters",
  "/shorts.v1alpha1.OwnershipService/ListSubstantialNotices",
  "/shorts.v1alpha1.ReportsService/GetWeeklyReport",
  "/shorts.v1alpha1.ShortedStocksService/CompareFundSnapshots",
  "/shorts.v1alpha1.ShortedStocksService/GetAnnouncement",
  "/shorts.v1alpha1.ShortedStocksService/GetAvailableDates",
  "/shorts.v1alpha1.ShortedStocksService/GetDirectorTrades",
  "/shorts.v1alpha1.ShortedStocksService/GetDividendHistory",
  "/shorts.v1alpha1.ShortedStocksService/GetFundPortfolio",
  "/shorts.v1alpha1.ShortedStocksService/GetIndustryIntelligence",
  "/shorts.v1alpha1.ShortedStocksService/GetIndustryTreeMap",
  "/shorts.v1alpha1.ShortedStocksService/GetInstitution",
  "/shorts.v1alpha1.ShortedStocksService/GetMarketByDate",
  "/shorts.v1alpha1.ShortedStocksService/GetMarketNews",
  "/shorts.v1alpha1.ShortedStocksService/GetNews",
  "/shorts.v1alpha1.ShortedStocksService/GetOwnershipActivity",
  "/shorts.v1alpha1.ShortedStocksService/GetOwnershipFlows",
  "/shorts.v1alpha1.ShortedStocksService/GetOwnershipMap",
  "/shorts.v1alpha1.ShortedStocksService/GetOwnershipOverview",
  "/shorts.v1alpha1.ShortedStocksService/GetPeerComparison",
  "/shorts.v1alpha1.ShortedStocksService/GetStock",
  "/shorts.v1alpha1.ShortedStocksService/GetStockData",
  "/shorts.v1alpha1.ShortedStocksService/GetStockDetails",
  "/shorts.v1alpha1.ShortedStocksService/GetStockFinancialHighlights",
  "/shorts.v1alpha1.ShortedStocksService/GetStockFundSeries",
  "/shorts.v1alpha1.ShortedStocksService/GetStockNews",
  "/shorts.v1alpha1.ShortedStocksService/GetStockOwnership",
  "/shorts.v1alpha1.ShortedStocksService/GetStockPrices",
  "/shorts.v1alpha1.ShortedStocksService/GetTopShorts",
  "/shorts.v1alpha1.ShortedStocksService/GetWeeklyReport",
  "/shorts.v1alpha1.ShortedStocksService/ListFundPositionChanges",
  "/shorts.v1alpha1.ShortedStocksService/ListFunds",
  "/shorts.v1alpha1.ShortedStocksService/ListInstitutions",
  "/shorts.v1alpha1.ShortedStocksService/ListStockRegisters",
  "/shorts.v1alpha1.ShortedStocksService/ListSubstantialNotices",
  "/shorts.v1alpha1.StockService/GetDirectorTrades",
  "/shorts.v1alpha1.StockService/GetDividendHistory",
  "/shorts.v1alpha1.StockService/GetPeerComparison",
  "/shorts.v1alpha1.StockService/GetStock",
  "/shorts.v1alpha1.StockService/GetStockData",
  "/shorts.v1alpha1.StockService/GetStockDetails",
  "/shorts.v1alpha1.StockService/GetStockFinancialHighlights",
  "/shorts.v1alpha1.StockService/GetStockPrices",
];

test("the allowlist is exactly the reviewed set of public reads", () => {
  assert.deepEqual(publicReadPaths(), REVIEWED_PUBLIC_READS);
});

/**
 * Maps `package.Service/Method` to whether the method's block carries the
 * VISIBILITY_PUBLIC annotation, for every rpc in the given proto directory.
 */
function protoRpcVisibility(dir) {
  const visibility = new Map();
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".proto"))) {
    const text = readFileSync(join(dir, file), "utf8");
    const pkg = /^package\s+([\w.]+)\s*;/m.exec(text)?.[1];
    if (!pkg) continue;
    const services = [...text.matchAll(/^service\s+(\w+)\s*\{/gm)];
    for (const rpc of text.matchAll(/^\s*rpc\s+(\w+)\s*\(/gm)) {
      const service = services.filter((s) => s.index < rpc.index).pop();
      if (!service) continue;
      const rest = text.slice(rpc.index + rpc[0].length);
      const next = rest.search(/^\s*(rpc|service|message|enum)\b/m);
      const block = next === -1 ? rest : rest.slice(0, next);
      visibility.set(`${pkg}.${service[1]}/${rpc[1]}`, /VISIBILITY_PUBLIC/.test(block));
    }
  }
  return visibility;
}

test("every allowlisted shorts read is a public method in the proto", () => {
  const visibility = protoRpcVisibility(fileURLToPath(new URL("../../proto/shortedapi/shorts/v1alpha1/", import.meta.url)));
  const shorts = publicReadPaths().filter((path) => path.startsWith("/shorts.v1alpha1."));
  // Listed for prewarm.js and the /edge/v1 news routes. The current protos
  // do not define them.
  const undefinedInProto = ["/shorts.v1alpha1.ShortedStocksService/GetAnnouncement", "/shorts.v1alpha1.ShortedStocksService/GetNews"];

  for (const path of shorts) {
    const key = path.slice(1);
    if (undefinedInProto.includes(path)) {
      assert.equal(visibility.has(key), false, `${key} is now defined; remove it from this list`);
      continue;
    }
    assert.equal(visibility.get(key), true, `${key} must be defined and VISIBILITY_PUBLIC`);
  }
});

test("every allowlisted market-data read is a method in its proto", () => {
  const visibility = protoRpcVisibility(fileURLToPath(new URL("../../proto/marketdata/v1/", import.meta.url)));
  for (const path of publicReadPaths().filter((p) => p.startsWith("/marketdata.v1."))) {
    assert.ok(visibility.has(path.slice(1)), `${path} must be defined in the market-data proto`);
  }
});

test("allowlisted market-data reads share one Cache API entry across callers", async () => {
  const path = "/marketdata.v1.MarketDataService/GetStockPrice";
  const body = JSON.stringify({ stock_code: "SHR2" });

  await withEdge(jsonOrigin, async ({ send, state }) => {
    const first = await send(rpc(path, body, { Authorization: "Bearer caller-a" }));
    assert.equal(first.headers.get("X-Shorted-Cache"), "MISS");
    const firstBody = await first.text();

    const anonymous = await send(rpc(path, body));
    assert.equal(anonymous.headers.get("X-Shorted-Cache"), "HIT");
    assert.equal(await anonymous.text(), firstBody);

    assert.equal(state.originCalls.length, 1);
    assert.equal(state.cacheWrites.length, 1);
    assert.ok(state.cacheWrites[0].includes("_cv=v1"));
    assert.ok(!state.cacheWrites[0].includes("caller-a"));
  });
});

test("a read outside the allowlist is never served from a seeded tier", async () => {
  const body = JSON.stringify({ item: "seeded" });
  const bodyHash = await sha256Hex(body);
  for (const path of [`${SHORTS}/ExampleWrite`, "/marketdata.v1.MarketDataService/ExampleWrite"]) {
    await withEdge(jsonOrigin, async ({ send, state }) => {
      // The entries a cacheable request for this path would read.
      state.cacheStore.set(`${API}${path}?_cv=v1&_bh=${bodyHash}`, new Response("seeded", {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
      const pathClean = path.replace(/\//g, "_").replace(/^_/, "");
      state.kvStore.set(`${KV_PREFIX}v1:${pathClean}:${bodyHash}`, "seeded");

      const response = await send(rpc(path, body, { Authorization: "Bearer caller-a" }));
      assert.equal(response.headers.get("X-Shorted-Cache"), "BYPASS", path);
      assert.equal((await response.json()).echoed, body, path);
      assert.equal(state.originCalls.length, 1, path);
      assert.deepEqual(state.kvReads.filter(isPrewarmKey), [], path);
    });
  }
});
