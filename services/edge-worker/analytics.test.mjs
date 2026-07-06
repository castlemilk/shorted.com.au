import assert from "node:assert/strict";
import test from "node:test";

import worker, {
  buildEdgeAnalyticsEvent,
  normalizeRouteGroup,
} from "./worker.js";

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
