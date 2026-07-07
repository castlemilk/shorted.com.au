import assert from "node:assert/strict";
import test from "node:test";

import worker, {
  buildEdgeAnalyticsEvent,
  normalizeRouteGroup,
} from "./worker.js";

function hashStringSyncForTest(text) {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

function versionedPrewarmKey(path, body, version) {
  const bodyHash = hashStringSyncForTest(body);
  const pathClean = path.replace(/\//g, "_").replace(/^_/, "");
  return `prewarm:${version}:${pathClean}:${bodyHash}`;
}

async function bodyToText(body) {
  if (!body) return "";
  if (typeof body === "string") return body;
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  if (ArrayBuffer.isView(body)) {
    return new TextDecoder().decode(body);
  }
  if (typeof body.text === "function") return body.text();
  return String(body);
}

test("uncached Shorts POST returns MISS and warms hot cache without re-reading the consumed body", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const waitUntilPromises = [];
  const originCalls = [];

  globalThis.caches = {
    default: {
      async match() {
        return undefined;
      },
      async put() {
        return undefined;
      },
    },
  };
  globalThis.fetch = async (url, init) => {
    originCalls.push({ url: String(url), method: init?.method });
    return new Response(JSON.stringify({ productCode: "TST", points: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const env = {
      SHORTS_API_ORIGIN: "https://shorts-origin.test",
      EDGE_ANALYTICS_SAMPLE_RATE: "0",
    };
    const ctx = {
      waitUntil(promise) {
        waitUntilPromises.push(Promise.resolve(promise));
      },
    };
    const url = "https://api.shorted.com.au/shorts.v1alpha1.ShortedStocksService/GetStockData";
    const body = JSON.stringify({ productCode: "TST" });

    const first = await worker.fetch(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
      env,
      ctx,
    );

    assert.equal(first.status, 200);
    assert.equal(first.headers.get("x-shorted-cache"), "MISS");
    assert.deepEqual(await first.json(), { productCode: "TST", points: [] });

    const second = await worker.fetch(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
      env,
      ctx,
    );

    assert.equal(second.status, 200);
    assert.equal(second.headers.get("x-shorted-cache"), "HOT");
    assert.equal(originCalls.length, 1);
    assert.equal(originCalls[0].url, url.replace("https://api.shorted.com.au", "https://shorts-origin.test"));
    assert.equal(waitUntilPromises.length, 1);
    assert.deepEqual(
      (await Promise.allSettled(waitUntilPromises)).map((result) => result.status),
      ["fulfilled"],
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) {
      delete globalThis.caches;
    } else {
      globalThis.caches = originalCaches;
    }
  }
});

test("cached Shorts POST fallback reuses a buffered body after origin fetch failure", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const originCalls = [];

  globalThis.caches = {
    default: {
      async match() {
        return undefined;
      },
      async put() {
        return undefined;
      },
    },
  };
  globalThis.fetch = async (url, init) => {
    originCalls.push({ url: String(url), init });
    if (originCalls.length === 1) {
      assert.ok(init?.body, "first origin call should receive the buffered POST body");
      throw new Error("transient origin failure after request body was consumed");
    }
    assert.ok(!(init instanceof Request), "fallback must not retry with the consumed original Request");
    assert.ok(init?.body, "fallback should reuse the buffered POST body");
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const env = {
      SHORTS_API_ORIGIN: "https://shorts-origin.test",
      EDGE_ANALYTICS_SAMPLE_RATE: "0",
    };
    const ctx = { waitUntil() {} };
    const url = "https://api.shorted.com.au/shorts.v1alpha1.ShortedStocksService/GetTopShorts";

    const response = await worker.fetch(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: 7 }),
      }),
      env,
      ctx,
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(originCalls.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) {
      delete globalThis.caches;
    } else {
      globalThis.caches = originalCaches;
    }
  }
});

test("cache write failures do not fail successful Shorts responses", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const waitUntilPromises = [];
  const originCalls = [];

  globalThis.caches = {
    default: {
      async match() {
        return undefined;
      },
      put() {
        throw new Error("cache put rejected response headers");
      },
    },
  };
  globalThis.fetch = async (url, init) => {
    originCalls.push({ url: String(url), method: init?.method, hasBody: Boolean(init?.body) });
    return new Response(JSON.stringify({ timeSeries: [{ productCode: "BHP" }] }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "private, max-age=0, no-store, no-cache, must-revalidate",
        vary: "Origin, accept-encoding",
      },
    });
  };

  try {
    const env = {
      SHORTS_API_ORIGIN: "https://shorts-origin.test",
      EDGE_ANALYTICS_SAMPLE_RATE: "0",
      EDGE_KV: {
        async get() {
          return null;
        },
        async put() {},
      },
    };
    const ctx = {
      waitUntil(promise) {
        waitUntilPromises.push(Promise.resolve(promise));
      },
    };
    const url = "https://api.shorted.com.au/shorts.v1alpha1.ShortedStocksService/GetTopShorts";

    const response = await worker.fetch(
      new Request(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "Mozilla/5.0 Shorted-E2E/1.0",
        },
        body: JSON.stringify({ limit: 3 }),
      }),
      env,
      ctx,
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-shorted-cache"), "MISS");
    assert.deepEqual(await response.json(), { timeSeries: [{ productCode: "BHP" }] });
    assert.equal(originCalls.length, 1);
    assert.equal(originCalls[0].hasBody, true);
    assert.equal(waitUntilPromises.length, 1);
    assert.deepEqual(
      (await Promise.allSettled(waitUntilPromises)).map((result) => result.status),
      ["fulfilled"],
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) {
      delete globalThis.caches;
    } else {
      globalThis.caches = originalCaches;
    }
  }
});

test("direct API chat RPC requests are blocked at the edge", async () => {
  const originalFetch = globalThis.fetch;
  let originCalled = false;

  globalThis.fetch = async () => {
    originCalled = true;
    return new Response("origin", { status: 200 });
  };

  try {
    const response = await worker.fetch(
      new Request("https://api.shorted.com.au/chat.v1.ChatService/SendMessage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "hello" }),
      }),
      {
        CHAT_SERVICE_ORIGIN: "https://chat-origin.test",
        EDGE_ANALYTICS_SAMPLE_RATE: "0",
      },
      { waitUntil() {} },
    );

    assert.equal(response.status, 404);
    assert.equal(originCalled, false);
    assert.equal(response.headers.get("x-shorted-edge"), "cloudflare");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("public GET edge read facade maps top shorts to cached Connect RPC with public cache headers", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const waitUntilPromises = [];
  const originCalls = [];

  globalThis.caches = {
    default: {
      async match() {
        return undefined;
      },
      async put() {
        return undefined;
      },
    },
  };
  globalThis.fetch = async (url, init) => {
    originCalls.push({ url: String(url), method: init?.method, body: init?.body });
    return new Response(JSON.stringify({ timeSeries: [{ productCode: "BHP" }], offset: 5 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const response = await worker.fetch(
      new Request("https://api.shorted.com.au/edge/v1/top-shorts?period=6m&limit=20&offset=5&summaryOnly=1"),
      {
        SHORTS_API_ORIGIN: "https://shorts-origin.test",
        CACHE_TTL_PUBLIC_DAILY: "3600",
        EDGE_ANALYTICS_SAMPLE_RATE: "0",
      },
      {
        waitUntil(promise) {
          waitUntilPromises.push(Promise.resolve(promise));
        },
      },
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-shorted-cache"), "MISS");
    assert.equal(response.headers.get("x-shorted-fast-path"), "edge-read");
    assert.match(response.headers.get("cache-control") || "", /public, max-age=3600/);
    assert.deepEqual(await response.json(), { timeSeries: [{ productCode: "BHP" }], offset: 5 });
    assert.equal(originCalls.length, 1);
    assert.equal(originCalls[0].url, "https://shorts-origin.test/shorts.v1alpha1.ShortedStocksService/GetTopShorts");
    assert.equal(originCalls[0].method, "POST");
    assert.equal(await bodyToText(originCalls[0].body), '{"period":"6m","limit":20,"offset":5,"summary_only":true}');
    assert.deepEqual(
      (await Promise.allSettled(waitUntilPromises)).map((result) => result.status),
      ["fulfilled"],
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});

test("public GET edge read facade reuses hot cache after first origin miss", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const waitUntilPromises = [];
  const originCalls = [];

  globalThis.caches = {
    default: {
      async match() {
        return undefined;
      },
      async put() {
        return undefined;
      },
    },
  };
  globalThis.fetch = async (url, init) => {
    originCalls.push({ url: String(url), method: init?.method, body: init?.body });
    return new Response(JSON.stringify({ timeSeries: [{ productCode: "BHP" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const env = {
      SHORTS_API_ORIGIN: "https://shorts-origin.test",
      CACHE_TTL_PUBLIC_DAILY: "3600",
      EDGE_ANALYTICS_SAMPLE_RATE: "0",
    };
    const ctx = {
      waitUntil(promise) {
        waitUntilPromises.push(Promise.resolve(promise));
      },
    };
    const requestUrl = "https://api.shorted.com.au/edge/v1/top-shorts?period=6m&limit=21&summaryOnly=1";

    const first = await worker.fetch(new Request(requestUrl), env, ctx);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("x-shorted-cache"), "MISS");
    assert.equal(first.headers.get("x-shorted-fast-path"), "edge-read");
    assert.match(first.headers.get("cache-control") || "", /public, max-age=3600/);
    assert.deepEqual(await first.json(), { timeSeries: [{ productCode: "BHP" }] });

    const second = await worker.fetch(new Request(requestUrl), env, ctx);
    assert.equal(second.status, 200);
    assert.equal(second.headers.get("x-shorted-cache"), "HOT");
    assert.equal(second.headers.get("x-shorted-fast-path"), "edge-read");
    assert.match(second.headers.get("cache-control") || "", /public, max-age=3600/);
    assert.deepEqual(await second.json(), { timeSeries: [{ productCode: "BHP" }] });

    assert.equal(originCalls.length, 1);
    assert.equal(originCalls[0].url, "https://shorts-origin.test/shorts.v1alpha1.ShortedStocksService/GetTopShorts");
    assert.equal(originCalls[0].method, "POST");
    assert.equal(await bodyToText(originCalls[0].body), '{"period":"6m","limit":21,"summary_only":true}');
    assert.deepEqual(
      (await Promise.allSettled(waitUntilPromises)).map((result) => result.status),
      ["fulfilled"],
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});

test("public GET edge read facade promotes Cache API hits into hot cache", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  let cacheMatchCalls = 0;

  globalThis.caches = {
    default: {
      async match() {
        cacheMatchCalls++;
        return new Response(JSON.stringify({ timeSeries: [{ productCode: "BHP" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      async put() {
        return undefined;
      },
    },
  };
  globalThis.fetch = async () => {
    throw new Error("origin should not be called for Cache API hits");
  };

  try {
    const env = {
      SHORTS_API_ORIGIN: "https://shorts-origin.test",
      CACHE_TTL_PUBLIC_DAILY: "3600",
      EDGE_ANALYTICS_SAMPLE_RATE: "0",
    };
    const ctx = { waitUntil() {} };
    const requestUrl = "https://api.shorted.com.au/edge/v1/top-shorts?period=6m&limit=20&summaryOnly=1";

    const first = await worker.fetch(new Request(requestUrl), env, ctx);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("x-shorted-cache"), "HIT");
    assert.equal(first.headers.get("x-shorted-fast-path"), "edge-read");
    assert.deepEqual(await first.json(), { timeSeries: [{ productCode: "BHP" }] });

    const second = await worker.fetch(new Request(requestUrl), env, ctx);
    assert.equal(second.status, 200);
    assert.equal(second.headers.get("x-shorted-cache"), "HOT");
    assert.equal(second.headers.get("x-shorted-fast-path"), "edge-read");
    assert.match(second.headers.get("cache-control") || "", /public, max-age=3600/);
    assert.deepEqual(await second.json(), { timeSeries: [{ productCode: "BHP" }] });
    assert.equal(cacheMatchCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});

test("public GET edge read facade can reuse prewarmed KV stock data", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const body = JSON.stringify({ product_code: "BHP", period: "3m" });
  const path = "/shorts.v1alpha1.ShortedStocksService/GetStockData";
  const key = versionedPrewarmKey(path, body, "v1");
  let originCalls = 0;

  globalThis.caches = {
    default: {
      async match() {
        return undefined;
      },
      async put() {
        return undefined;
      },
    },
  };
  globalThis.fetch = async () => {
    originCalls++;
    return new Response(JSON.stringify({ origin: true }), { status: 200 });
  };

  try {
    const response = await worker.fetch(
      new Request("https://api.shorted.com.au/edge/v1/stock/BHP/data?period=3m"),
      {
        SHORTS_API_ORIGIN: "https://shorts-origin.test",
        CACHE_TTL_PUBLIC_DAILY: "3600",
        EDGE_ANALYTICS_SAMPLE_RATE: "0",
        EDGE_KV: {
          async get(k) {
            if (k === "control:cache-version") return "v1";
            if (k === key) return JSON.stringify({ productCode: "BHP", points: [] });
            return null;
          },
          async put() {},
        },
      },
      { waitUntil() {} },
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-shorted-cache"), "KV");
    assert.equal(response.headers.get("x-shorted-fast-path"), "edge-read");
    assert.match(response.headers.get("cache-control") || "", /public, max-age=3600/);
    assert.deepEqual(await response.json(), { productCode: "BHP", points: [] });
    assert.equal(originCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});

test("KV cache covers stock detail page RPCs beyond the summary endpoint", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const body = JSON.stringify({ product_code: "CBA", period: "3m" });
  const path = "/shorts.v1alpha1.ShortedStocksService/GetStockData";
  const key = versionedPrewarmKey(path, body, "v1");
  let originCalls = 0;

  globalThis.caches = {
    default: {
      async match() {
        return undefined;
      },
      async put() {
        return undefined;
      },
    },
  };
  globalThis.fetch = async () => {
    originCalls++;
    return new Response(JSON.stringify({ origin: true }), { status: 200 });
  };

  try {
    const response = await worker.fetch(
      new Request(`https://api.shorted.com.au${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
      {
        SHORTS_API_ORIGIN: "https://shorts-origin.test",
        EDGE_ANALYTICS_SAMPLE_RATE: "0",
        EDGE_KV: {
          async get(k) {
            if (k === "control:cache-version") return "v1";
            if (k === key) return JSON.stringify({ fromKv: true });
            return null;
          },
          async put() {},
        },
      },
      { waitUntil() {} },
    );

    assert.equal(response.headers.get("x-shorted-cache"), "KV");
    assert.deepEqual(await response.json(), { fromKv: true });
    assert.equal(originCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});

test("cache purge clears hot cache and bumps the shared cache version", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const originBodies = [{ value: "before" }, { value: "after" }];
  const puts = [];
  let originCalls = 0;

  globalThis.caches = {
    default: {
      async match() {
        return undefined;
      },
      async put() {
        return undefined;
      },
    },
  };
  globalThis.fetch = async () => {
    const body = originBodies[Math.min(originCalls, originBodies.length - 1)];
    originCalls++;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const env = {
    SHORTS_API_ORIGIN: "https://shorts-origin.test",
    CACHE_PURGE_SECRET: "secret",
    EDGE_ANALYTICS_SAMPLE_RATE: "0",
    EDGE_KV: {
      version: "v1",
      async get(k) {
        if (k === "control:cache-version") return this.version;
        return null;
      },
      async put(k, v) {
        puts.push({ k, v });
        if (k === "control:cache-version") this.version = v;
      },
    },
  };
  const ctx = { waitUntil() {} };
  const url = "https://api.shorted.com.au/shorts.v1alpha1.ShortedStocksService/GetAvailableDates";

  try {
    const first = await worker.fetch(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ marker: "purge-test" }),
      }),
      env,
      ctx,
    );
    assert.equal(first.headers.get("x-shorted-cache"), "MISS");
    assert.deepEqual(await first.json(), { value: "before" });

    const purge = await worker.fetch(
      new Request("https://api.shorted.com.au/api/cache/purge", {
        method: "POST",
        body: "secret",
      }),
      env,
      ctx,
    );
    assert.equal(purge.status, 200);
    const purgeBody = await purge.json();
    assert.equal(purgeBody.status, "purged");
    assert.ok(purgeBody.cacheVersion);
    assert.equal(puts.some((put) => put.k === "control:cache-version"), true);

    const second = await worker.fetch(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ marker: "purge-test" }),
      }),
      env,
      ctx,
    );
    assert.equal(second.headers.get("x-shorted-cache"), "MISS");
    assert.deepEqual(await second.json(), { value: "after" });
    assert.equal(originCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
});

test("normalizes user-facing routes into low-cardinality groups", () => {
  assert.equal(normalizeRouteGroup("shorted.com.au", "/"), "/");
  assert.equal(normalizeRouteGroup("shorted.com.au", "/shorts/BHP"), "/shorts/[code]");
  assert.equal(normalizeRouteGroup("shorted.com.au", "/shorts/BHP/news"), "/shorts/[code]/news");
  assert.equal(
    normalizeRouteGroup("shorted.com.au", "/shorts/BHP/community/thread-123"),
    "/shorts/[code]/community/[threadId]",
  );
  assert.equal(normalizeRouteGroup("shorted.com.au", "/portfolio/holdings"), "/portfolio");
  assert.equal(normalizeRouteGroup("shorted.com.au", "/dashboards/custom"), "/dashboards");
  assert.equal(normalizeRouteGroup("shorted.com.au", "/api/community/BHP/threads/thread-123/comments"), "/api/community/[code]/threads/[threadId]/comments");
  assert.equal(normalizeRouteGroup("shorted.com.au", "/_next/static/chunks/app.js"), "/_next/static/*");
});

test("builds queryable edge analytics fields for API requests", () => {
  const request = new Request("https://api.shorted.com.au/shorts.v1alpha1.ShortsService/GetStock", {
    method: "POST",
    headers: {
      "cf-ray": "abc123-MEL",
      referer: "https://shorted.com.au/shorts/BHP?tab=community",
    },
  });
  Object.defineProperty(request, "cf", {
    value: { colo: "MEL", clientBot: false },
  });

  const response = new Response("{}", {
    status: 200,
    headers: {
      "content-length": "2",
      "x-shorted-cache": "MISS",
    },
  });

  const event = buildEdgeAnalyticsEvent(request, response, {
    origin: "shorts",
    cacheTtl: 120,
    started: 1_000,
    now: 1_275,
  });

  assert.equal(event.type, "edge_request");
  assert.equal(event.host, "api.shorted.com.au");
  assert.equal(event.route_group, "/rpc/shorts/GetStock");
  assert.equal(event.referer_group, "/shorts/[code]");
  assert.equal(event.feature, "shorts");
  assert.equal(event.api_family, "shorts");
  assert.equal(event.rpc_method, "GetStock");
  assert.equal(event.cacheable, true);
  assert.equal(event.cache_status, "MISS");
  assert.equal(event.cf_ray, "abc123-MEL");
  assert.equal(event.cf_colo, "MEL");
  assert.equal(event.cf_client_bot, false);
  assert.equal(event.duration_ms, 275);
  assert.equal(event.response_bytes, 2);
});

test("builds queryable edge analytics fields for frontend API routes", () => {
  const request = new Request("https://shorted.com.au/api/community/BHP/pulse/pulse-1/replies", {
    method: "GET",
    headers: {
      referer: "https://shorted.com.au/shorts/BHP/community/thread-123",
    },
  });
  const response = new Response("{}", {
    status: 200,
    headers: {
      "x-shorted-cache": "BYPASS",
    },
  });

  const event = buildEdgeAnalyticsEvent(request, response, {
    origin: "frontend",
    cacheTtl: 0,
    started: 500,
    now: 620,
  });

  assert.equal(event.route_group, "/api/community/[code]/pulse/[pulseId]/replies");
  assert.equal(event.referer_group, "/shorts/[code]/community/[threadId]");
  assert.equal(event.feature, "community");
  assert.equal(event.api_family, "next-api");
  assert.equal(event.rpc_method, "");
  assert.equal(event.cacheable, false);
});
