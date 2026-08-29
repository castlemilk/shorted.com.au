import assert from "node:assert/strict";
import test from "node:test";

import worker, {
  __resetEdgeEventStateForTests,
  bucketDuration,
  buildBypassEvent,
  buildEdgeConfigEvent,
  buildOriginErrorEvent,
  buildUpstreamLatencyEvent,
  classifyFetchError,
  isOriginFailureStatus,
  recordBypassUsage,
  recordCachePurge,
  recordEdgeConfigOnce,
  recordKvError,
  recordOriginError,
  recordUpstreamLatency,
  resolveBypassAttempt,
  resolveNamedSampleRate,
  resolveOriginName,
  statusClass,
} from "./worker.js";

// ---------------------------------------------------------------------------
// Fixtures and harness
//
// Every secret-shaped value here is DISTINCT and improbable so the leakage
// tests below can grep serialized events for the real values, exactly as
// ratelimit-observability.test.mjs does.
// ---------------------------------------------------------------------------

const SHORTS_ORIGIN = "https://shorts-uiekqxovma-km.a.run.app";
const MARKET_ORIGIN = "https://market-data-uiekqxovma-km.a.run.app";
const CHAT_ORIGIN = "https://chat-service-uiekqxovma-km.a.run.app";

const SSR_SECRET = "ssr-secret-value-9876543210abc";
const TESTING_SECRET = "testing-secret-value-0123456789";
const PURGE_SECRET = "purge-secret-value-abcdef123456";
const CLIENT_IP = "203.0.113.77";

const RPC_PATH = "/shorts.v1alpha1.MarketService/GetTopShorts";

const BYPASS_ENV = {
  RATE_LIMIT_TESTING_BYPASS_SECRET: TESTING_SECRET,
  RATE_LIMIT_TESTING_BYPASS_USER_AGENT: "Shorted-E2E",
  RATE_LIMIT_TESTING_BYPASS_HEADER_NAME: "x-shorted-testing-bypass",
  RATE_LIMIT_SSR_BYPASS_SECRET: SSR_SECRET,
  RATE_LIMIT_SSR_BYPASS_USER_AGENT: "shorted-web-ssr",
  RATE_LIMIT_SSR_BYPASS_HEADER_NAME: "x-shorted-ssr-bypass",
};

function baseEnv(extra = {}) {
  return {
    SHORTS_API_ORIGIN: SHORTS_ORIGIN,
    MARKET_DATA_ORIGIN: MARKET_ORIGIN,
    CHAT_SERVICE_ORIGIN: CHAT_ORIGIN,
    CACHE_PURGE_SECRET: PURGE_SECRET,
    ...BYPASS_ENV,
    ...extra,
  };
}

function apiRequest(path = RPC_PATH, headers = {}) {
  return new Request(`https://api.shorted.com.au${path}`, {
    method: "POST",
    headers: { "cf-connecting-ip": CLIENT_IP, "cf-ray": "abc123-MEL", ...headers },
    body: "{}",
  });
}

/** Capture every JSON console line written during `fn`, optionally filtered. */
async function captureEvents(fn, type = null) {
  const original = console.log;
  const lines = [];
  console.log = (line) => lines.push(line);
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_) {
        return null;
      }
    })
    .filter((event) => event && (type === null || event.type === type));
}

async function withRandom(value, fn) {
  const original = Math.random;
  Math.random = () => value;
  try {
    return await fn();
  } finally {
    Math.random = original;
  }
}

/**
 * Drive `worker.fetch` with a stubbed origin. The unknown-path route goes
 * straight through `proxyWithHeaders`, so no Cache API is needed; the RPC route
 * needs a stub `caches.default`.
 */
async function withStubbedOrigin({ status = 200, throwError = null } = {}, fn) {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const calls = [];
  globalThis.caches = { default: { async match() {}, async put() {} } };
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (throwError) throw throwError;
    return new Response("{}", { status, headers: { "Content-Type": "application/json" } });
  };
  try {
    return { calls, result: await fn(calls) };
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
  }
}

test.beforeEach(() => {
  __resetEdgeEventStateForTests();
});

// ---------------------------------------------------------------------------
// Bounded vocabularies — the cardinality contract
// ---------------------------------------------------------------------------

test("duration buckets are bounded and cover every boundary", () => {
  assert.equal(bucketDuration(0), "<50ms");
  assert.equal(bucketDuration(49), "<50ms");
  assert.equal(bucketDuration(50), "50-200ms");
  assert.equal(bucketDuration(199), "50-200ms");
  assert.equal(bucketDuration(200), "200-500ms");
  assert.equal(bucketDuration(499), "200-500ms");
  assert.equal(bucketDuration(500), "500-1000ms");
  assert.equal(bucketDuration(999), "500-1000ms");
  assert.equal(bucketDuration(1000), "1000-3000ms");
  assert.equal(bucketDuration(2999), "1000-3000ms");
  assert.equal(bucketDuration(3000), "3000ms+");
  assert.equal(bucketDuration(999999), "3000ms+");
  // Garbage in must still produce a bucket, never a crash or a new label.
  assert.equal(bucketDuration(-1), "<50ms");
  assert.equal(bucketDuration(NaN), "<50ms");
  assert.equal(bucketDuration(undefined), "<50ms");

  const labels = new Set(
    [0, 50, 200, 500, 1000, 3000, 10000, -5, NaN].map((n) => bucketDuration(n))
  );
  assert.equal(labels.size, 6, "exactly six buckets exist, forever");
});

test("status classes are bounded", () => {
  assert.equal(statusClass(0), "error");
  assert.equal(statusClass(100), "1xx");
  assert.equal(statusClass(200), "2xx");
  assert.equal(statusClass(301), "3xx");
  assert.equal(statusClass(404), "4xx");
  assert.equal(statusClass(503), "5xx");
  assert.equal(statusClass(NaN), "error");
});

test("4xx is NOT an origin failure — the origin working is not an incident", () => {
  assert.equal(isOriginFailureStatus(400), false);
  assert.equal(isOriginFailureStatus(401), false);
  assert.equal(isOriginFailureStatus(404), false);
  assert.equal(isOriginFailureStatus(429), false);
  assert.equal(isOriginFailureStatus(200), false);
  assert.equal(isOriginFailureStatus(204), false);

  assert.equal(isOriginFailureStatus(500), true);
  assert.equal(isOriginFailureStatus(502), true);
  assert.equal(isOriginFailureStatus(503), true);
  assert.equal(isOriginFailureStatus(0), true, "a throw has no status");
});

test("a 3xx is a fault from an API origin but normal from Vercel", () => {
  assert.equal(isOriginFailureStatus(302, "shorts"), true);
  assert.equal(isOriginFailureStatus(308, "market-data"), true);
  assert.equal(isOriginFailureStatus(308, "frontend"), false);
  assert.equal(isOriginFailureStatus(503, "frontend"), true);
});

test("fetch errors classify into a bounded set and discard the message", () => {
  assert.equal(classifyFetchError(new Error("connection reset by peer")), "network");
  assert.equal(classifyFetchError(new Error("request timed out")), "timeout");
  assert.equal(classifyFetchError(Object.assign(new Error("x"), { name: "AbortError" })), "aborted");
  assert.equal(classifyFetchError(new Error("something else entirely")), "internal");
  assert.equal(classifyFetchError(null), "internal");
  assert.equal(classifyFetchError(undefined), "internal");
  assert.equal(classifyFetchError("a bare string"), "internal");

  // THE POINT: a Workers TypeError can embed the request URL, and that URL can
  // carry a query string. The class must never contain any of it.
  const leaky = new Error(
    "fetch failed: https://origin.internal/rpc?api_key=sk-live-LEAKED-TOKEN-123"
  );
  const cls = classifyFetchError(leaky);
  assert.ok(!cls.includes("LEAKED"));
  assert.ok(!cls.includes("sk-live"));
  assert.ok(["timeout", "aborted", "network", "internal"].includes(cls));
});

test("origin names are bounded, and a raw origin URL is never one of them", () => {
  const env = baseEnv();
  assert.equal(resolveOriginName(env, SHORTS_ORIGIN), "shorts");
  assert.equal(resolveOriginName(env, MARKET_ORIGIN), "market-data");
  assert.equal(resolveOriginName(env, CHAT_ORIGIN), "chat");
  assert.equal(resolveOriginName(env, "https://shorted.com.au"), "frontend");
  assert.equal(resolveOriginName(env, "https://someone-else.example"), "other");
  assert.equal(resolveOriginName(env, ""), "unknown");
  assert.equal(resolveOriginName(undefined, SHORTS_ORIGIN), "other");
});

// ---------------------------------------------------------------------------
// edge_origin_error
// ---------------------------------------------------------------------------

test("edge_origin_error emits the full contract for an origin 5xx", () => {
  const event = buildOriginErrorEvent(apiRequest(), {
    origin: "shorts",
    status: 503,
    path: RPC_PATH,
    durationMs: 412,
  });

  assert.deepEqual(event, {
    type: "edge_origin_error",
    origin: "shorts",
    status: 503,
    status_class: "5xx",
    error_class: "",
    path: RPC_PATH,
    route_group: "/rpc/shorts/GetTopShorts",
    api_family: "shorts",
    rpc_method: "GetTopShorts",
    method: "POST",
    cf_colo: "",
    cf_ray: "abc123-MEL",
    duration_ms: 412,
    served_stale: false,
    retried: false,
    sample_rate: 1,
  });
});

test("a thrown origin fetch reports status 0 and a bounded error_class", () => {
  const event = buildOriginErrorEvent(apiRequest(), {
    origin: "market-data",
    status: 0,
    errorClass: "timeout",
    path: RPC_PATH,
    durationMs: 30000,
  });
  assert.equal(event.status, 0);
  assert.equal(event.status_class, "error");
  assert.equal(event.error_class, "timeout");
  assert.equal(event.duration_ms, 30000);
});

test("worker.fetch emits edge_origin_error when the origin 503s", async () => {
  const env = baseEnv();
  const events = await captureEvents(
    () =>
      withStubbedOrigin({ status: 503 }, () =>
        worker.fetch(apiRequest("/unknown/path"), env, { waitUntil() {} })
      ),
    "edge_origin_error"
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].origin, "shorts");
  assert.equal(events[0].status, 503);
  assert.equal(events[0].status_class, "5xx");
  assert.equal(events[0].retried, false);
});

test("worker.fetch stays silent when the origin returns a 404", async () => {
  const events = await captureEvents(
    () =>
      withStubbedOrigin({ status: 404 }, () =>
        worker.fetch(apiRequest("/unknown/path"), baseEnv(), { waitUntil() {} })
      ),
    "edge_origin_error"
  );
  assert.equal(events.length, 0);
});

test("a throwing origin produces TWO events — the attempt and the retry", async () => {
  // proxyWithHeaders retries once on a throw. Two events for one client
  // request is the accurate statement that both attempts failed.
  const events = await captureEvents(async () => {
    await withStubbedOrigin({ throwError: new Error("connection refused") }, async () => {
      await assert.rejects(() =>
        worker.fetch(apiRequest("/unknown/path"), baseEnv(), { waitUntil() {} })
      );
    });
  }, "edge_origin_error");

  assert.equal(events.length, 2);
  assert.equal(events[0].retried, false);
  assert.equal(events[1].retried, true);
  for (const event of events) {
    assert.equal(event.status, 0);
    assert.equal(event.error_class, "network");
  }
});

test("edge_origin_error is emitted at 100% even with all sampling disabled", async () => {
  const env = baseEnv({ EDGE_ANALYTICS_SAMPLE_RATE: "0", EDGE_UPSTREAM_LATENCY_SAMPLE_RATE: "0" });
  const events = await withRandom(0.999999, () =>
    captureEvents(
      () =>
        withStubbedOrigin({ status: 500 }, () =>
          worker.fetch(apiRequest("/unknown/path"), env, { waitUntil() {} })
        ),
      "edge_origin_error"
    )
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].sample_rate, 1);
});

// ---------------------------------------------------------------------------
// edge_upstream_latency
// ---------------------------------------------------------------------------

test("edge_upstream_latency carries a bucket and never a raw millisecond field", () => {
  const response = new Response("{}", { status: 200, headers: { "X-Shorted-Cache": "MISS" } });
  const event = buildUpstreamLatencyEvent(apiRequest(), response, {
    origin: "shorts",
    cacheTtl: 300,
    started: 0,
    now: 640,
    sampleRate: 0.01,
  });

  assert.deepEqual(event, {
    type: "edge_upstream_latency",
    origin: "shorts",
    cache_status: "MISS",
    duration_bucket: "500-1000ms",
    status: 200,
    status_class: "2xx",
    path: RPC_PATH,
    route_group: "/rpc/shorts/GetTopShorts",
    api_family: "shorts",
    rpc_method: "GetTopShorts",
    method: "POST",
    cf_colo: "",
    cf_ray: "abc123-MEL",
    cache_ttl_seconds: 300,
    sample_rate: 0.01,
  });
  assert.ok(!("duration_ms" in event), "raw ms must not be a dimension here");
});

test("cache_status is the field that answers 'is caching helping'", () => {
  const hit = buildUpstreamLatencyEvent(
    apiRequest(),
    new Response("{}", { status: 200, headers: { "X-Shorted-Cache": "HOT" } }),
    { origin: "shorts", started: 0, now: 3, sampleRate: 1 }
  );
  assert.equal(hit.cache_status, "HOT");
  assert.equal(hit.duration_bucket, "<50ms");

  const miss = buildUpstreamLatencyEvent(
    apiRequest(),
    new Response("{}", { status: 200, headers: { "X-Shorted-Cache": "MISS" } }),
    { origin: "shorts", started: 0, now: 1500, sampleRate: 1 }
  );
  assert.equal(miss.cache_status, "MISS");
  assert.equal(miss.duration_bucket, "1000-3000ms");
});

test("upstream latency is sampled away below its rate, and reports its rate", async () => {
  const response = new Response("{}", { status: 200, headers: { "X-Shorted-Cache": "HIT" } });

  const dropped = await withRandom(0.5, () =>
    captureEvents(
      () =>
        recordUpstreamLatency(
          apiRequest(),
          { EDGE_UPSTREAM_LATENCY_SAMPLE_RATE: "0.01" },
          response,
          "shorts",
          0,
          Date.now()
        ),
      "edge_upstream_latency"
    )
  );
  assert.equal(dropped.length, 0);

  const kept = await withRandom(0.1, () =>
    captureEvents(
      () =>
        recordUpstreamLatency(
          apiRequest(),
          { EDGE_UPSTREAM_LATENCY_SAMPLE_RATE: "0.25" },
          response,
          "shorts",
          0,
          Date.now()
        ),
      "edge_upstream_latency"
    )
  );
  assert.equal(kept.length, 1);
  assert.equal(kept[0].sample_rate, 0.25);
});

test("EDGE_UPSTREAM_LATENCY_SAMPLE_RATE inherits when blank, like the others", () => {
  assert.equal(
    resolveNamedSampleRate({ EDGE_ANALYTICS_SAMPLE_RATE: "0.05" }, "EDGE_UPSTREAM_LATENCY_SAMPLE_RATE"),
    0.05
  );
  assert.equal(
    resolveNamedSampleRate(
      { EDGE_ANALYTICS_SAMPLE_RATE: "0.05", EDGE_UPSTREAM_LATENCY_SAMPLE_RATE: "" },
      "EDGE_UPSTREAM_LATENCY_SAMPLE_RATE"
    ),
    0.05,
    "blank must inherit — Terraform emits '' for the -1 sentinel"
  );
  assert.equal(
    resolveNamedSampleRate({ EDGE_UPSTREAM_LATENCY_SAMPLE_RATE: "0.5" }, "EDGE_UPSTREAM_LATENCY_SAMPLE_RATE"),
    0.5
  );
  assert.equal(resolveNamedSampleRate({}, "EDGE_UPSTREAM_LATENCY_SAMPLE_RATE"), 0.01);
  assert.equal(resolveNamedSampleRate({ EDGE_BYPASS_SAMPLE_RATE: "9" }, "EDGE_BYPASS_SAMPLE_RATE"), 1);
  assert.equal(resolveNamedSampleRate({ EDGE_BYPASS_SAMPLE_RATE: "-2" }, "EDGE_BYPASS_SAMPLE_RATE"), 0);
});

// ---------------------------------------------------------------------------
// edge_config — the once-per-isolate guarantee is the whole feature
// ---------------------------------------------------------------------------

test("edge_config is emitted exactly ONCE per isolate, not once per request", async () => {
  const env = baseEnv({ EDGE_ANALYTICS_SAMPLE_RATE: "1" });
  const events = await captureEvents(
    () =>
      withStubbedOrigin({ status: 200 }, async () => {
        for (let i = 0; i < 25; i++) {
          await worker.fetch(apiRequest("/unknown/path"), env, { waitUntil() {} });
        }
      }),
    "edge_config"
  );
  assert.equal(events.length, 1, "25 requests, one config snapshot");
});

test("recordEdgeConfigOnce is idempotent under direct hammering", async () => {
  const events = await captureEvents(() => {
    for (let i = 0; i < 500; i++) recordEdgeConfigOnce(baseEnv(), apiRequest());
  }, "edge_config");
  assert.equal(events.length, 1);
});

test("a new isolate emits a fresh snapshot", async () => {
  const first = await captureEvents(() => recordEdgeConfigOnce(baseEnv(), apiRequest()), "edge_config");
  assert.equal(first.length, 1);
  __resetEdgeEventStateForTests(); // simulates isolate recycle
  const second = await captureEvents(() => recordEdgeConfigOnce(baseEnv(), apiRequest()), "edge_config");
  assert.equal(second.length, 1);
});

test("edge_config reports secrets as BOOLEANS only, never values or lengths", () => {
  const event = buildEdgeConfigEvent(baseEnv(), apiRequest());
  assert.deepEqual(event.secrets_present, {
    testing_bypass: true,
    ssr_bypass: true,
    cache_purge: true,
  });

  const serialized = JSON.stringify(event);
  for (const secret of [TESTING_SECRET, SSR_SECRET, PURGE_SECRET]) {
    assert.ok(!serialized.includes(secret), `edge_config leaked ${secret}`);
  }
  // A length is a real hint about a secret — no numeric field may equal one.
  assert.ok(!serialized.includes(String(TESTING_SECRET.length)));

  const empty = buildEdgeConfigEvent({}, apiRequest());
  assert.deepEqual(empty.secrets_present, {
    testing_bypass: false,
    ssr_bypass: false,
    cache_purge: false,
  });
});

test("edge_config exposes the limits AND whether their bindings are actually bound", () => {
  const bound = { async limit() { return { success: true }; } };
  const env = baseEnv({
    EDGE_RATE_LIMIT_ENABLED: "true",
    RATE_LIMIT_ANON_BURST: "10",
    RATE_LIMIT_ANON_LIMIT: "30",
    ANON_BURST_RATE_LIMITER: bound,
    ANON_RATE_LIMITER: bound,
  });
  const event = buildEdgeConfigEvent(env, apiRequest());

  assert.equal(event.rate_limit_enabled, true);
  assert.deepEqual(event.buckets["api-anon"], {
    burst_limit: 10,
    sustained_limit: 30,
    burst_bound: true,
    sustained_bound: true,
  });
  // THE KILLER CASE: enabled, configured — and doing nothing, because the
  // binding never landed.
  assert.deepEqual(event.buckets["api-key"], {
    burst_limit: 100,
    sustained_limit: 600,
    burst_bound: false,
    sustained_bound: false,
  });
  // first-party is burst-only by design, so its sustained arm is never bound.
  assert.equal(event.buckets["first-party"].sustained_bound, false);
  assert.deepEqual(Object.keys(event.buckets).sort(), [
    "api-anon",
    "api-key",
    "browser-anon",
    "browser-auth",
    "first-party",
    "mcp-anon",
  ]);
});

test("edge_config reports the deploy id, bindings, origins and TTLs", () => {
  const env = baseEnv({
    EDGE_DEPLOY_ID: "a1b2c3d4e5f6",
    EDGE_KV: { async get() {}, async put() {} },
    EDGE_EVENTS_ANALYTICS: { writeDataPoint() {} },
    CACHE_TTL_TOP_SHORTS: "600",
  });
  const event = buildEdgeConfigEvent(env, apiRequest());

  assert.equal(event.deploy_id, "a1b2c3d4e5f6");
  assert.deepEqual(event.bindings, {
    edge_kv: true,
    rate_limit_analytics: false,
    edge_events_analytics: true,
  });
  // Hostnames, never full URLs — no paths and no query strings.
  assert.equal(event.origins.shorts, "shorts-uiekqxovma-km.a.run.app");
  assert.equal(event.origins.market_data, "market-data-uiekqxovma-km.a.run.app");
  assert.ok(!JSON.stringify(event.origins).includes("https://"));
  assert.equal(event.cache_ttl_seconds.top_shorts, 600);
  assert.equal(event.cache_ttl_seconds.default, 60);
  assert.equal(event.sample_rates.edge_request, 0.01);
});

test("edge_config survives a completely empty env", () => {
  assert.doesNotThrow(() => buildEdgeConfigEvent({}, null));
  const event = buildEdgeConfigEvent({}, null);
  assert.equal(event.type, "edge_config");
  assert.equal(event.rate_limit_enabled, false);
  assert.equal(event.deploy_id, "");
});

// ---------------------------------------------------------------------------
// edge_bypass_used
// ---------------------------------------------------------------------------

test("bypass attempts resolve to accepted / rejected / unconfigured", () => {
  const env = baseEnv();

  assert.deepEqual(
    resolveBypassAttempt(
      apiRequest(RPC_PATH, { "user-agent": "Shorted-E2E/1.0", "x-shorted-testing-bypass": TESTING_SECRET }),
      env
    ),
    { bypassClass: "testing", outcome: "accepted" }
  );

  // A marker with the WRONG secret: a probe, and the loudest thing here.
  assert.deepEqual(
    resolveBypassAttempt(
      apiRequest(RPC_PATH, { "user-agent": "Shorted-E2E/1.0", "x-shorted-testing-bypass": "guess" }),
      env
    ),
    { bypassClass: "testing", outcome: "rejected" }
  );

  // A marker with NO secret header at all is still a rejection.
  assert.deepEqual(
    resolveBypassAttempt(apiRequest(RPC_PATH, { "user-agent": "Shorted-E2E/1.0" }), env),
    { bypassClass: "testing", outcome: "rejected" }
  );

  // The misconfiguration case: marker arrives, worker has no secret bound.
  assert.deepEqual(
    resolveBypassAttempt(apiRequest(RPC_PATH, { "user-agent": "Mozilla/5.0 shorted-web-ssr" }), {}),
    { bypassClass: "ssr", outcome: "unconfigured" }
  );

  assert.deepEqual(resolveBypassAttempt(apiRequest(), env), { bypassClass: "", outcome: "" });
});

test("a testing bypass is emitted at 100% even at sample rate 0", async () => {
  const env = baseEnv({ EDGE_BYPASS_SAMPLE_RATE: "0", EDGE_ANALYTICS_SAMPLE_RATE: "0" });
  const request = apiRequest(RPC_PATH, {
    "user-agent": "Shorted-E2E/1.0",
    "x-shorted-testing-bypass": TESTING_SECRET,
  });

  const events = await withRandom(0.999999, () =>
    captureEvents(() => recordBypassUsage(request, env, RPC_PATH, "api.shorted.com.au"), "edge_bypass_used")
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].bypass_class, "testing");
  assert.equal(events[0].outcome, "accepted");
  assert.equal(events[0].sample_rate, 1, "no knob can sample the leaked-secret detector away");
});

test("a REJECTED bypass is emitted at 100% for either class", async () => {
  const env = baseEnv({ EDGE_BYPASS_SAMPLE_RATE: "0" });
  const request = apiRequest(RPC_PATH, {
    "user-agent": "Mozilla/5.0 shorted-web-ssr",
    "x-shorted-ssr-bypass": "wrong-secret-guess-attempt",
  });

  const events = await withRandom(0.999999, () =>
    captureEvents(() => recordBypassUsage(request, env, RPC_PATH, "api.shorted.com.au"), "edge_bypass_used")
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].bypass_class, "ssr");
  assert.equal(events[0].outcome, "rejected");
  assert.equal(events[0].sample_rate, 1);
});

test("routine SSR bypass usage IS sampled — it is the steady state, not a signal", async () => {
  const env = baseEnv({ EDGE_BYPASS_SAMPLE_RATE: "0.01" });
  const request = apiRequest(RPC_PATH, {
    "user-agent": "Mozilla/5.0 shorted-web-ssr",
    "x-shorted-ssr-bypass": SSR_SECRET,
  });

  const dropped = await withRandom(0.5, () =>
    captureEvents(() => recordBypassUsage(request, env, RPC_PATH, "api.shorted.com.au"), "edge_bypass_used")
  );
  assert.equal(dropped.length, 0);

  const kept = await withRandom(0.001, () =>
    captureEvents(() => recordBypassUsage(request, env, RPC_PATH, "api.shorted.com.au"), "edge_bypass_used")
  );
  assert.equal(kept.length, 1);
  assert.equal(kept[0].outcome, "accepted");
  assert.equal(kept[0].sample_rate, 0.01);
});

test("a bypass is observable even when rate limiting is DISABLED — the gap this closes", async () => {
  // With EDGE_RATE_LIMIT_ENABLED unset, enforceEdgeRateLimit returns before it
  // resolves any bypass, so edge_rate_limit emits nothing. A leaked E2E secret
  // would previously have been completely silent.
  const env = baseEnv();
  assert.equal(env.EDGE_RATE_LIMIT_ENABLED, undefined);

  const request = apiRequest("/unknown/path", {
    "user-agent": "Shorted-E2E/1.0",
    "x-shorted-testing-bypass": TESTING_SECRET,
  });

  const all = await captureEvents(() =>
    withStubbedOrigin({ status: 200 }, () => worker.fetch(request, env, { waitUntil() {} }))
  );

  const bypass = all.filter((e) => e.type === "edge_bypass_used");
  const rateLimit = all.filter((e) => e.type === "edge_rate_limit");
  assert.equal(bypass.length, 1);
  assert.equal(bypass[0].enforcement_enabled, false);
  assert.equal(rateLimit.length, 0, "the old stream is silent here — that is the gap");
});

test("edge_bypass_used pins its full shape", () => {
  const event = buildBypassEvent(apiRequest(), {
    bypassClass: "ssr",
    outcome: "accepted",
    surface: "api",
    path: RPC_PATH,
    enforcementEnabled: true,
    eligiblePath: true,
    sampleRate: 0.01,
  });

  assert.deepEqual(event, {
    type: "edge_bypass_used",
    bypass_class: "ssr",
    outcome: "accepted",
    surface: "api",
    path: RPC_PATH,
    route_group: "/rpc/shorts/GetTopShorts",
    api_family: "shorts",
    rpc_method: "GetTopShorts",
    method: "POST",
    cf_colo: "",
    cf_ray: "abc123-MEL",
    enforcement_enabled: true,
    eligible_path: true,
    // Only ever non-zero on the capped unproven-claim arm; pinned here so the
    // field cannot quietly disappear from the contract.
    suppressed: 0,
    sample_rate: 0.01,
  });
});

// ---------------------------------------------------------------------------
// edge_kv_error
// ---------------------------------------------------------------------------

test("edge_kv_error names the operation and the key SPACE, never the key", async () => {
  const events = await captureEvents(
    () =>
      recordKvError({}, apiRequest(), {
        op: "get",
        keyKind: "prewarm",
        error: new Error("KV get failed for prewarm:v1:_shorts.v1alpha1_GetStock:abc"),
        path: RPC_PATH,
      }),
    "edge_kv_error"
  );

  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    type: "edge_kv_error",
    op: "get",
    key_kind: "prewarm",
    error_class: "internal",
    path: RPC_PATH,
    route_group: "/rpc/shorts/GetTopShorts",
    api_family: "shorts",
    rpc_method: "GetTopShorts",
    method: "POST",
    cf_colo: "",
    cf_ray: "abc123-MEL",
    suppressed: 0,
    sample_rate: 1,
  });
  // The failing key was in the error message and must not have survived.
  assert.ok(!JSON.stringify(events[0]).includes("prewarm:v1:"));
});

test("a KV outage cannot turn the emitter into the outage", async () => {
  // 500 consecutive failures inside one 60s window must not produce 500 lines.
  const events = await captureEvents(() => {
    for (let i = 0; i < 500; i++) {
      recordKvError({}, apiRequest(), { op: "get", keyKind: "prewarm", error: new Error("kv down") });
    }
  }, "edge_kv_error");

  assert.equal(events.length, 20, "capped at 20 per isolate per minute");
  assert.ok(events.every((e) => e.suppressed === 0));

  // The dropped volume is reported, never silently lost: the next window's
  // first event carries the backlog.
  __resetEdgeEventStateForTests();
});

test("suppressed volume is reported on the next emitted event", async () => {
  const originalNow = Date.now;
  let clock = 1_000_000;
  Date.now = () => clock;
  try {
    // Fill the window and overflow it by 5.
    await captureEvents(() => {
      for (let i = 0; i < 25; i++) {
        recordKvError({}, null, { op: "get", keyKind: "prewarm", error: new Error("kv down") });
      }
    }, "edge_kv_error");

    clock += 61_000; // next window
    const next = await captureEvents(
      () => recordKvError({}, null, { op: "get", keyKind: "prewarm", error: new Error("kv down") }),
      "edge_kv_error"
    );
    assert.equal(next.length, 1);
    assert.equal(next[0].suppressed, 5);
  } finally {
    Date.now = originalNow;
  }
});

test("a failing KV read is instrumented through the real cache path", async () => {
  const env = baseEnv({
    EDGE_KV: {
      async get() {
        throw new Error("KV namespace unavailable");
      },
      async put() {},
    },
  });

  const events = await captureEvents(
    () =>
      withStubbedOrigin({ status: 200 }, () =>
        worker.fetch(
          new Request(`https://api.shorted.com.au${RPC_PATH}`, { method: "POST", body: "{}" }),
          env,
          { waitUntil(p) { return p; } }
        )
      ),
    "edge_kv_error"
  );

  assert.ok(events.length >= 1);
  // The control read (cache version) fails first, then the prewarm read.
  assert.ok(events.some((e) => e.key_kind === "control" && e.op === "version-get"));
  assert.ok(events.some((e) => e.key_kind === "prewarm" && e.op === "get"));
});

// ---------------------------------------------------------------------------
// edge_cache_purge
// ---------------------------------------------------------------------------

test("a successful purge is recorded", async () => {
  const env = baseEnv({
    EDGE_KV: { async get() { return null; }, async put() {} },
  });
  const request = new Request("https://api.shorted.com.au/api/cache/purge", {
    method: "POST",
    body: PURGE_SECRET,
  });

  const events = await captureEvents(
    () => worker.fetch(request, env, { waitUntil() {} }),
    "edge_cache_purge"
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].outcome, "purged");
  assert.equal(events[0].reason, "");
  assert.equal(events[0].route_group, "/api/*");
});

test("a purge that cannot write KV is recorded as failed, with a bounded reason", async () => {
  const env = baseEnv({
    EDGE_KV: {
      async get() { return null; },
      async put() { throw new Error("KV write rejected"); },
    },
  });
  const request = new Request("https://api.shorted.com.au/api/cache/purge", {
    method: "POST",
    body: PURGE_SECRET,
  });

  const all = await captureEvents(() => worker.fetch(request, env, { waitUntil() {} }));
  const purge = all.filter((e) => e.type === "edge_cache_purge");
  const kv = all.filter((e) => e.type === "edge_kv_error");

  assert.equal(purge.length, 1);
  assert.equal(purge[0].outcome, "failed");
  assert.equal(purge[0].reason, "kv-write-failed");
  assert.equal(kv.length, 1);
  assert.equal(kv[0].op, "version-put");
  assert.equal(kv[0].key_kind, "control");
});

test("an unauthorized purge attempt is recorded and echoes nothing from the body", async () => {
  const guess = "attacker-guess-at-the-purge-secret";
  const request = new Request("https://api.shorted.com.au/api/cache/purge", {
    method: "POST",
    body: guess,
  });

  const events = await captureEvents(
    () => worker.fetch(request, baseEnv(), { waitUntil() {} }),
    "edge_cache_purge"
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].outcome, "unauthorized");
  assert.equal(events[0].reason, "bad-secret");
  const serialized = JSON.stringify(events[0]);
  assert.ok(!serialized.includes(guess), "the purge body must never be echoed");
  assert.ok(!serialized.includes(PURGE_SECRET));
});

test("a purge with no KV binding is recorded as failed", async () => {
  const request = new Request("https://api.shorted.com.au/api/cache/purge", {
    method: "POST",
    body: PURGE_SECRET,
  });
  const events = await captureEvents(
    () => worker.fetch(request, baseEnv(), { waitUntil() {} }),
    "edge_cache_purge"
  );
  assert.equal(events[0].outcome, "failed");
  assert.equal(events[0].reason, "kv-unbound");
});

// ---------------------------------------------------------------------------
// Leakage: the same grep contract as ratelimit-observability.test.mjs
// ---------------------------------------------------------------------------

test("no secret, credential, cookie, IP or raw URL appears in ANY new event", async () => {
  const API_TOKEN = "sk-live-token-that-must-never-be-logged";
  const SESSION_VALUE = "session-cookie-value-that-must-never-be-logged";
  const forbidden = [API_TOKEN, SESSION_VALUE, CLIENT_IP, SSR_SECRET, TESTING_SECRET, PURGE_SECRET];

  const env = baseEnv({
    EDGE_DEPLOY_ID: "deadbeef1234",
    EDGE_ANALYTICS_SAMPLE_RATE: "1",
    EDGE_BYPASS_SAMPLE_RATE: "1",
    EDGE_UPSTREAM_LATENCY_SAMPLE_RATE: "1",
    EDGE_KV: {
      async get() { throw new Error(`KV failed reading key for ${API_TOKEN}`); },
      async put() {},
    },
  });

  // A request that carries EVERY secret shape at once, plus a query string.
  const request = new Request(
    `https://api.shorted.com.au${RPC_PATH}?api_key=${API_TOKEN}&debug=1`,
    {
      method: "POST",
      headers: {
        "cf-connecting-ip": CLIENT_IP,
        "cf-ray": "abc123-MEL",
        authorization: `Bearer ${API_TOKEN}`,
        cookie: `__Secure-next-auth.session-token=${SESSION_VALUE}`,
        "user-agent": "Mozilla/5.0 shorted-web-ssr",
        "x-shorted-ssr-bypass": SSR_SECRET,
        "x-shorted-testing-bypass": TESTING_SECRET,
      },
      body: "{}",
    }
  );

  const events = await captureEvents(() =>
    withStubbedOrigin({ status: 503 }, () => worker.fetch(request, env, { waitUntil(p) { return p; } }))
  );

  const newTypes = new Set([
    "edge_origin_error",
    "edge_upstream_latency",
    "edge_config",
    "edge_bypass_used",
    "edge_kv_error",
    "edge_cache_purge",
  ]);
  const observed = events.filter((e) => newTypes.has(e.type));
  assert.ok(observed.length >= 4, `expected the new streams to fire, saw ${observed.length}`);

  for (const event of observed) {
    const serialized = JSON.stringify(event);
    for (const secret of forbidden) {
      assert.ok(!serialized.includes(secret), `${event.type} leaked ${secret}`);
    }
    assert.ok(!serialized.includes("api_key="), `${event.type} leaked a query string`);
    assert.ok(!serialized.includes("Bearer "), `${event.type} leaked an auth header`);
    assert.ok(!serialized.includes("https://api.shorted.com.au"), `${event.type} leaked a raw URL`);
  }

  // Also assert each new stream carries a sample_rate, so ratio queries are
  // always correctable — the same contract as edge_rate_limit.
  for (const event of observed) {
    assert.equal(typeof event.sample_rate, "number", `${event.type} has no sample_rate`);
  }
});

// ---------------------------------------------------------------------------
// Instrumentation must never throw into the request path
// ---------------------------------------------------------------------------

test("every new emitter swallows a throwing console.log", () => {
  const original = console.log;
  console.log = () => {
    throw new Error("log transport exploded");
  };
  try {
    assert.doesNotThrow(() =>
      recordOriginError(apiRequest(), {}, { origin: "shorts", status: 503, path: RPC_PATH, durationMs: 1 })
    );
    assert.doesNotThrow(() =>
      recordUpstreamLatency(apiRequest(), { EDGE_UPSTREAM_LATENCY_SAMPLE_RATE: "1" }, new Response("{}"), "shorts", 0, 0)
    );
    assert.doesNotThrow(() => recordEdgeConfigOnce(baseEnv(), apiRequest()));
    assert.doesNotThrow(() =>
      recordBypassUsage(
        apiRequest(RPC_PATH, { "user-agent": "Shorted-E2E", "x-shorted-testing-bypass": TESTING_SECRET }),
        baseEnv(),
        RPC_PATH,
        "api.shorted.com.au"
      )
    );
    assert.doesNotThrow(() =>
      recordKvError({}, apiRequest(), { op: "get", keyKind: "prewarm", error: new Error("x") })
    );
    assert.doesNotThrow(() => recordCachePurge({}, apiRequest(), { outcome: "purged" }));
  } finally {
    console.log = original;
  }
});

test("every new emitter survives a malformed request object", () => {
  const junk = [null, undefined, { url: "not a url", headers: null }, {}];
  for (const request of junk) {
    assert.doesNotThrow(() =>
      recordOriginError(request, {}, { origin: "shorts", status: 500, path: RPC_PATH, durationMs: 0 })
    );
    assert.doesNotThrow(() =>
      recordBypassUsage(request, baseEnv(), RPC_PATH, "api.shorted.com.au")
    );
    assert.doesNotThrow(() =>
      recordKvError({}, request, { op: "get", keyKind: "prewarm", error: new Error("x") })
    );
    assert.doesNotThrow(() => recordCachePurge({}, request, { outcome: "failed", reason: "kv-unbound" }));
  }
  assert.doesNotThrow(() => recordEdgeConfigOnce({}, null));
});

test("a throwing Analytics Engine binding cannot break a request", async () => {
  const env = baseEnv({
    EDGE_EVENTS_ANALYTICS: {
      writeDataPoint() {
        throw new Error("analytics engine unavailable");
      },
    },
  });

  const events = await captureEvents(
    () =>
      withStubbedOrigin({ status: 503 }, async () => {
        const response = await worker.fetch(apiRequest("/unknown/path"), env, { waitUntil() {} });
        assert.equal(response.status, 503, "the client still got its response");
      }),
    "edge_origin_error"
  );
  assert.equal(events.length, 1, "the JSON line still landed — it is the source of truth");
});

// ---------------------------------------------------------------------------
// Analytics Engine positional schema (optional binding)
//
// AE columns are positional and may only ever be APPENDED, so the exact
// mapping is pinned here. If this test fails, every saved SQL query in
// docs/observability/cost-attribution.md is now wrong.
// ---------------------------------------------------------------------------

test("no EDGE_EVENTS_ANALYTICS binding is a silent no-op", async () => {
  const env = baseEnv();
  assert.equal(env.EDGE_EVENTS_ANALYTICS, undefined);
  const events = await captureEvents(
    () =>
      withStubbedOrigin({ status: 500 }, () =>
        worker.fetch(apiRequest("/unknown/path"), env, { waitUntil() {} })
      ),
    "edge_origin_error"
  );
  assert.equal(events.length, 1);
});

test("an origin_error data point uses the documented positional schema", async () => {
  const writes = [];
  const env = { EDGE_EVENTS_ANALYTICS: { writeDataPoint: (p) => writes.push(p) } };

  await captureEvents(() =>
    recordOriginError(apiRequest(), env, {
      origin: "shorts",
      status: 503,
      path: RPC_PATH,
      durationMs: 412,
    })
  );

  assert.equal(writes.length, 1);
  const point = writes[0];
  assert.deepEqual(point.indexes, ["origin_error"]);
  assert.deepEqual(point.blobs, [
    "origin_error", // blob1  event_kind
    "shorts", // blob2  origin
    "5xx", // blob3  outcome_class (status_class for this kind)
    "", // blob4  cache_status (n/a)
    "shorts", // blob5  api_family
    "GetTopShorts", // blob6  rpc_method
    RPC_PATH, // blob7  path
    "POST", // blob8  method
    "", // blob9  cf_colo
    "/rpc/shorts/GetTopShorts", // blob10 route_group
    "5xx", // blob11 status_class
    "", // blob12 error_class
  ]);
  assert.deepEqual(point.doubles, [503, 412, 1, 0]);
});

test("an upstream_latency data point shares the schema, keyed by duration bucket", async () => {
  const writes = [];
  const env = {
    EDGE_UPSTREAM_LATENCY_SAMPLE_RATE: "1",
    EDGE_EVENTS_ANALYTICS: { writeDataPoint: (p) => writes.push(p) },
  };
  const response = new Response("{}", { status: 200, headers: { "X-Shorted-Cache": "HIT" } });

  await captureEvents(() =>
    recordUpstreamLatency(apiRequest(), env, response, "shorts", 300, Date.now())
  );

  assert.equal(writes.length, 1);
  const point = writes[0];
  assert.deepEqual(point.indexes, ["upstream_latency"]);
  assert.equal(point.blobs[0], "upstream_latency");
  assert.equal(point.blobs[2], "<50ms", "outcome_class is the duration bucket for this kind");
  assert.equal(point.blobs[3], "HIT");
  assert.equal(point.blobs[10], "2xx");
  assert.equal(point.doubles[0], 200);
  assert.equal(point.doubles[2], 1);
});

test("data points stay inside Cloudflare's Analytics Engine limits", async () => {
  const writes = [];
  const env = {
    EDGE_UPSTREAM_LATENCY_SAMPLE_RATE: "1",
    EDGE_EVENTS_ANALYTICS: { writeDataPoint: (p) => writes.push(p) },
  };

  await captureEvents(() => {
    recordOriginError(apiRequest(), env, { origin: "shorts", status: 502, path: RPC_PATH, durationMs: 5 });
    recordUpstreamLatency(apiRequest(), env, new Response("{}"), "shorts", 0, Date.now());
  });

  assert.equal(writes.length, 2);
  for (const point of writes) {
    assert.ok(point.blobs.length <= 20, "max 20 blobs");
    assert.ok(point.doubles.length <= 20, "max 20 doubles");
    assert.equal(point.indexes.length, 1, "exactly 1 index");
    assert.ok(new TextEncoder().encode(point.indexes[0]).length <= 96, "index max 96 bytes");
    assert.ok(point.blobs.every((b) => typeof b === "string"));
    assert.ok(point.doubles.every((d) => typeof d === "number" && Number.isFinite(d)));
  }
});
