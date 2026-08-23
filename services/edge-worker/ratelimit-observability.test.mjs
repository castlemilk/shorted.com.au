import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEdgeAnalyticsEvent,
  buildRateLimitEvent,
  enforceEdgeRateLimit,
  recordRateLimitDecision,
  resolveRateLimitSampleRate,
} from "./worker.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** Mock of a Cloudflare Rate Limiting binding: `limit({ key }) -> { success }`. */
function mockLimiter({ allow = true } = {}) {
  const calls = [];
  return {
    calls,
    async limit(options) {
      calls.push(options);
      return { success: allow };
    },
  };
}

const BINDING_NAMES = [
  "API_KEY_BURST_RATE_LIMITER",
  "API_KEY_RATE_LIMITER",
  "ANON_BURST_RATE_LIMITER",
  "ANON_RATE_LIMITER",
  "FIRST_PARTY_RATE_LIMITER",
  "BROWSER_ANON_BURST_RATE_LIMITER",
  "BROWSER_ANON_RATE_LIMITER",
  "BROWSER_AUTH_BURST_RATE_LIMITER",
  "BROWSER_AUTH_RATE_LIMITER",
];

const SSR_SECRET = "ssr-secret-value-9876543210abc";
const TESTING_SECRET = "testing-secret-value-0123456789";

const BYPASS_ENV = {
  RATE_LIMIT_TESTING_BYPASS_SECRET: TESTING_SECRET,
  RATE_LIMIT_TESTING_BYPASS_USER_AGENT: "Shorted-E2E",
  RATE_LIMIT_TESTING_BYPASS_HEADER_NAME: "x-shorted-testing-bypass",
  RATE_LIMIT_SSR_BYPASS_SECRET: SSR_SECRET,
  RATE_LIMIT_SSR_BYPASS_USER_AGENT: "shorted-web-ssr",
  RATE_LIMIT_SSR_BYPASS_HEADER_NAME: "x-shorted-ssr-bypass",
};

/** Env with every binding wired to one shared allow/deny mock. */
function bindingsEnv({ allow = true, ...rest } = {}) {
  const env = { EDGE_RATE_LIMIT_ENABLED: "true", ...rest };
  for (const name of BINDING_NAMES) env[name] = mockLimiter({ allow });
  return env;
}

const RPC_PATH = "/shorts.v1alpha1.MarketService/GetTopShorts";
const CLIENT_IP = "203.0.113.77";
const SESSION_VALUE = "session-cookie-value-that-must-never-be-logged";
const API_TOKEN = "sk-live-token-that-must-never-be-logged";

function apiRequest(path = RPC_PATH, headers = {}) {
  return new Request(`https://api.shorted.com.au${path}`, {
    method: "POST",
    headers: { "cf-connecting-ip": CLIENT_IP, "cf-ray": "abc123-MEL", ...headers },
    body: "{}",
  });
}

function browserRequest(path = RPC_PATH, headers = {}) {
  return new Request(`https://shorted.com.au${path}`, {
    headers: { "cf-connecting-ip": CLIENT_IP, "cf-ray": "abc123-MEL", ...headers },
  });
}

/**
 * Capture every JSON line the worker writes to console.log during `fn`.
 * Returns only the parsed edge_rate_limit events.
 */
async function captureEvents(fn) {
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
    .filter((event) => event && event.type === "edge_rate_limit");
}

/** Force Math.random to a fixed value for deterministic sampling assertions. */
async function withRandom(value, fn) {
  const original = Math.random;
  Math.random = () => value;
  try {
    return await fn();
  } finally {
    Math.random = original;
  }
}

// ---------------------------------------------------------------------------
// Event shape, per bucket class
// ---------------------------------------------------------------------------

test("a limited api-anon burst decision emits the full event contract", async () => {
  const env = bindingsEnv({ allow: false, ...BYPASS_ENV });
  const events = await captureEvents(() =>
    enforceEdgeRateLimit(apiRequest(), env, RPC_PATH, "api.shorted.com.au")
  );

  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    type: "edge_rate_limit",
    decision: "limited",
    bucket_class: "api-anon",
    surface: "api",
    window: "10s",
    limit: 10,
    burst_limit: 10,
    sustained_limit: 30,
    path: RPC_PATH,
    route_group: "/rpc/shorts/GetTopShorts",
    api_family: "shorts",
    rpc_method: "GetTopShorts",
    method: "POST",
    key_type: "ip",
    bypass_class: "",
    cf_colo: "",
    cf_ray: "abc123-MEL",
    sample_rate: 1,
  });
});

test("api-key limited decisions report a token-hash key type and the token limits", async () => {
  const env = bindingsEnv({ allow: false, ...BYPASS_ENV });
  const events = await captureEvents(() =>
    enforceEdgeRateLimit(
      apiRequest(RPC_PATH, { authorization: `Bearer ${API_TOKEN}` }),
      env,
      RPC_PATH,
      "api.shorted.com.au"
    )
  );

  assert.equal(events[0].bucket_class, "api-key");
  assert.equal(events[0].key_type, "token-hash");
  assert.equal(events[0].limit, 100);
  assert.equal(events[0].burst_limit, 100);
  assert.equal(events[0].sustained_limit, 600);
});

test("first-party decisions carry bypass_class ssr and no sustained window", async () => {
  const env = bindingsEnv({ EDGE_RATE_LIMIT_SAMPLE_RATE: "1", ...BYPASS_ENV });
  const request = apiRequest(RPC_PATH, {
    "user-agent": "Mozilla/5.0 shorted-web-ssr",
    "x-shorted-ssr-bypass": SSR_SECRET,
  });
  const events = await captureEvents(() =>
    enforceEdgeRateLimit(request, env, RPC_PATH, "api.shorted.com.au")
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].decision, "allowed");
  assert.equal(events[0].bucket_class, "first-party");
  assert.equal(events[0].bypass_class, "ssr");
  assert.equal(events[0].key_type, "ip");
  assert.equal(events[0].burst_limit, 600);
  // Burst-only class: there is no 60s bucket to report.
  assert.equal(events[0].sustained_limit, 0);
});

test("browser-anon and browser-auth classes are distinguished by key_type", async () => {
  const anon = await captureEvents(() =>
    enforceEdgeRateLimit(
      browserRequest("/api/market-data/x"),
      bindingsEnv({ allow: false, ...BYPASS_ENV }),
      "/api/market-data/x",
      "shorted.com.au"
    )
  );
  assert.equal(anon[0].bucket_class, "browser-anon");
  assert.equal(anon[0].surface, "browser");
  assert.equal(anon[0].key_type, "ip");

  const auth = await captureEvents(() =>
    enforceEdgeRateLimit(
      browserRequest("/api/market-data/x", {
        cookie: `__Secure-next-auth.session-token=${SESSION_VALUE}`,
      }),
      bindingsEnv({ allow: false, ...BYPASS_ENV }),
      "/api/market-data/x",
      "shorted.com.au"
    )
  );
  assert.equal(auth[0].bucket_class, "browser-auth");
  assert.equal(auth[0].surface, "browser");
  assert.equal(auth[0].key_type, "session-hash");
  assert.equal(auth[0].burst_limit, 200);
  assert.equal(auth[0].sustained_limit, 1200);
});

test("a sustained (60s) rejection reports window 60s and the sustained limit", async () => {
  const env = bindingsEnv({ ...BYPASS_ENV });
  // Burst allows, sustained rejects.
  env.ANON_RATE_LIMITER = mockLimiter({ allow: false });

  const events = await captureEvents(() =>
    enforceEdgeRateLimit(apiRequest(), env, RPC_PATH, "api.shorted.com.au")
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].decision, "limited");
  assert.equal(events[0].window, "60s");
  assert.equal(events[0].limit, 30);
});

test("allowed decisions carry no window and a zero limit", async () => {
  const events = await captureEvents(() =>
    enforceEdgeRateLimit(
      apiRequest(),
      bindingsEnv({ EDGE_RATE_LIMIT_SAMPLE_RATE: "1", ...BYPASS_ENV }),
      RPC_PATH,
      "api.shorted.com.au"
    )
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].decision, "allowed");
  assert.equal(events[0].window, "");
  assert.equal(events[0].limit, 0);
  // The ceilings in effect are still reported, so a denominator query knows them.
  assert.equal(events[0].burst_limit, 10);
  assert.equal(events[0].sustained_limit, 30);
});

test("bypass classes are observable: testing skips buckets but still emits", async () => {
  const env = bindingsEnv({ EDGE_RATE_LIMIT_SAMPLE_RATE: "1", ...BYPASS_ENV });
  const request = apiRequest(RPC_PATH, {
    "user-agent": "Shorted-E2E/1.0",
    "x-shorted-testing-bypass": TESTING_SECRET,
  });

  const events = await captureEvents(() =>
    enforceEdgeRateLimit(request, env, RPC_PATH, "api.shorted.com.au")
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].decision, "allowed");
  assert.equal(events[0].bypass_class, "testing");
  assert.equal(events[0].bucket_class, "");
  assert.equal(events[0].key_type, "");
  // No bucket was consulted at all.
  assert.equal(env.ANON_BURST_RATE_LIMITER.calls.length, 0);
});

test("crawler exemptions are observable as bypass_class crawler", async () => {
  const env = bindingsEnv({ EDGE_RATE_LIMIT_SAMPLE_RATE: "1", ...BYPASS_ENV });
  const request = apiRequest(RPC_PATH, { "user-agent": "Googlebot/2.1" });

  const events = await captureEvents(() =>
    enforceEdgeRateLimit(request, env, RPC_PATH, "api.shorted.com.au")
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].bypass_class, "crawler");
  assert.equal(events[0].decision, "allowed");
});

test("paths are normalized, never raw — a query string can never reach an event", () => {
  const event = buildRateLimitEvent(
    new Request("https://shorted.com.au/dashboards/secret?token=leak", { method: "GET" }),
    { decision: "allowed", surface: "browser", bucketClass: "browser-anon", path: "/dashboards/secret" }
  );
  assert.equal(event.path, "/*page");
  assert.equal(event.route_group, "/dashboards");
  assert.ok(!JSON.stringify(event).includes("leak"));
});

// ---------------------------------------------------------------------------
// The sampling asymmetry: limited is 100%, allowed is sampled
// ---------------------------------------------------------------------------

test("every limited decision is emitted even at sample rate 0", async () => {
  // Sample rate 0 AND the worst possible Math.random draw. A 429 still logs.
  const env = bindingsEnv({
    allow: false,
    EDGE_RATE_LIMIT_SAMPLE_RATE: "0",
    EDGE_ANALYTICS_SAMPLE_RATE: "0",
    ...BYPASS_ENV,
  });

  const events = await withRandom(0.999999, () =>
    captureEvents(() => enforceEdgeRateLimit(apiRequest(), env, RPC_PATH, "api.shorted.com.au"))
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].decision, "limited");
  assert.equal(events[0].sample_rate, 1, "a limited event must report sample_rate 1");
});

test("100 limited decisions produce 100 events at the default 1% rate", async () => {
  const env = bindingsEnv({ allow: false, ...BYPASS_ENV });
  const events = await captureEvents(async () => {
    for (let i = 0; i < 100; i++) {
      await enforceEdgeRateLimit(apiRequest(), env, RPC_PATH, "api.shorted.com.au");
    }
  });
  assert.equal(events.length, 100);
});

test("allowed decisions ARE sampled away below the rate", async () => {
  const env = bindingsEnv({ EDGE_RATE_LIMIT_SAMPLE_RATE: "0.01", ...BYPASS_ENV });
  const events = await withRandom(0.5, () =>
    captureEvents(() => enforceEdgeRateLimit(apiRequest(), env, RPC_PATH, "api.shorted.com.au"))
  );
  assert.equal(events.length, 0);
});

test("allowed decisions report the sample rate that produced them", async () => {
  const env = bindingsEnv({ EDGE_RATE_LIMIT_SAMPLE_RATE: "0.25", ...BYPASS_ENV });
  const events = await withRandom(0.1, () =>
    captureEvents(() => enforceEdgeRateLimit(apiRequest(), env, RPC_PATH, "api.shorted.com.au"))
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].sample_rate, 0.25);
});

test("EDGE_RATE_LIMIT_SAMPLE_RATE overrides, and inherits when blank", () => {
  assert.equal(resolveRateLimitSampleRate({ EDGE_ANALYTICS_SAMPLE_RATE: "0.05" }), 0.05);
  assert.equal(
    resolveRateLimitSampleRate({ EDGE_ANALYTICS_SAMPLE_RATE: "0.05", EDGE_RATE_LIMIT_SAMPLE_RATE: "" }),
    0.05,
    "blank must inherit — Terraform emits '' for the -1 sentinel"
  );
  assert.equal(
    resolveRateLimitSampleRate({ EDGE_ANALYTICS_SAMPLE_RATE: "0.05", EDGE_RATE_LIMIT_SAMPLE_RATE: "0.5" }),
    0.5
  );
  assert.equal(resolveRateLimitSampleRate({}), 0.01, "default is the existing 1%");
  assert.equal(resolveRateLimitSampleRate({ EDGE_RATE_LIMIT_SAMPLE_RATE: "7" }), 1, "clamped");
  assert.equal(resolveRateLimitSampleRate({ EDGE_RATE_LIMIT_SAMPLE_RATE: "-3" }), 0, "clamped");
});

// ---------------------------------------------------------------------------
// Leakage: no credential, cookie or IP may appear in any field
// ---------------------------------------------------------------------------

test("no API token, session cookie or client IP appears anywhere in an event", async () => {
  const cases = [
    // api-key: the token is hashed into the bucket key and must not be emitted.
    () =>
      enforceEdgeRateLimit(
        apiRequest(RPC_PATH, { authorization: `Bearer ${API_TOKEN}` }),
        bindingsEnv({ allow: false, ...BYPASS_ENV }),
        RPC_PATH,
        "api.shorted.com.au"
      ),
    // api-anon: keyed by the raw client IP.
    () =>
      enforceEdgeRateLimit(
        apiRequest(),
        bindingsEnv({ allow: false, ...BYPASS_ENV }),
        RPC_PATH,
        "api.shorted.com.au"
      ),
    // browser-auth: keyed by a session-cookie hash.
    () =>
      enforceEdgeRateLimit(
        browserRequest("/api/market-data/x", {
          cookie: `__Secure-next-auth.session-token=${SESSION_VALUE}`,
        }),
        bindingsEnv({ allow: false, ...BYPASS_ENV }),
        "/api/market-data/x",
        "shorted.com.au"
      ),
    // ssr bypass: the shared secret must never be echoed.
    () =>
      enforceEdgeRateLimit(
        apiRequest(RPC_PATH, {
          "user-agent": "shorted-web-ssr",
          "x-shorted-ssr-bypass": SSR_SECRET,
        }),
        bindingsEnv({ allow: false, EDGE_RATE_LIMIT_SAMPLE_RATE: "1", ...BYPASS_ENV }),
        RPC_PATH,
        "api.shorted.com.au"
      ),
    // testing bypass: same.
    () =>
      enforceEdgeRateLimit(
        apiRequest(RPC_PATH, {
          "user-agent": "Shorted-E2E/1.0",
          "x-shorted-testing-bypass": TESTING_SECRET,
        }),
        bindingsEnv({ EDGE_RATE_LIMIT_SAMPLE_RATE: "1", ...BYPASS_ENV }),
        RPC_PATH,
        "api.shorted.com.au"
      ),
  ];

  const forbidden = [API_TOKEN, SESSION_VALUE, CLIENT_IP, SSR_SECRET, TESTING_SECRET];

  for (const run of cases) {
    const events = await captureEvents(run);
    assert.ok(events.length >= 1);
    for (const event of events) {
      const serialized = JSON.stringify(event);
      for (const secret of forbidden) {
        assert.ok(
          !serialized.includes(secret),
          `event leaked a secret/identifier: ${secret} in ${serialized}`
        );
      }
      // Nor may a hash of the credential appear: key_type is the ONLY identity
      // field, and it is drawn from a fixed vocabulary.
      assert.ok(
        ["", "ip", "token-hash", "session-hash"].includes(event.key_type),
        `unexpected key_type ${event.key_type}`
      );
      assert.ok(!("key" in event), "the bucket key must never be a field");
    }
  }
});

// ---------------------------------------------------------------------------
// Instrumentation must never throw into the request path
// ---------------------------------------------------------------------------

test("recordRateLimitDecision swallows a throwing console.log", () => {
  const original = console.log;
  console.log = () => {
    throw new Error("log transport exploded");
  };
  try {
    assert.doesNotThrow(() =>
      recordRateLimitDecision(apiRequest(), { EDGE_RATE_LIMIT_SAMPLE_RATE: "1" }, {
        decision: "limited",
        surface: "api",
        bucketClass: "api-anon",
        path: RPC_PATH,
        window: "10s",
        limit: 10,
      })
    );
  } finally {
    console.log = original;
  }
});

test("recordRateLimitDecision survives a malformed request object", () => {
  assert.doesNotThrow(() =>
    recordRateLimitDecision(null, {}, { decision: "limited", surface: "api", path: RPC_PATH })
  );
  assert.doesNotThrow(() =>
    recordRateLimitDecision({ url: "not a url", headers: null }, {}, {
      decision: "limited",
      surface: "api",
      bucketClass: "api-anon",
      path: RPC_PATH,
    })
  );
});

test("a throwing Analytics Engine binding cannot break enforcement", async () => {
  const env = bindingsEnv({ allow: false, ...BYPASS_ENV });
  env.RATE_LIMIT_ANALYTICS = {
    writeDataPoint() {
      throw new Error("analytics engine unavailable");
    },
  };

  const events = await captureEvents(async () => {
    const response = await enforceEdgeRateLimit(apiRequest(), env, RPC_PATH, "api.shorted.com.au");
    // Enforcement still produced its 429.
    assert.equal(response.status, 429);
  });
  // And the JSON line still landed — it is the source of truth.
  assert.equal(events.length, 1);
});

test("a throwing limiter binding still yields a fail-open null, not an exception", async () => {
  const env = { EDGE_RATE_LIMIT_ENABLED: "true", ...BYPASS_ENV };
  env.ANON_BURST_RATE_LIMITER = {
    async limit() {
      throw new Error("binding exploded");
    },
  };
  const response = await enforceEdgeRateLimit(apiRequest(), env, RPC_PATH, "api.shorted.com.au");
  assert.equal(response, null);
});

// ---------------------------------------------------------------------------
// Analytics Engine data point (optional binding)
// ---------------------------------------------------------------------------

test("no Analytics Engine binding is a silent no-op", async () => {
  const env = bindingsEnv({ allow: false, ...BYPASS_ENV });
  assert.equal(env.RATE_LIMIT_ANALYTICS, undefined);
  const events = await captureEvents(() =>
    enforceEdgeRateLimit(apiRequest(), env, RPC_PATH, "api.shorted.com.au")
  );
  assert.equal(events.length, 1, "the console event is unaffected by the missing binding");
});

test("a bound Analytics Engine dataset receives the documented positional schema", async () => {
  const writes = [];
  const env = bindingsEnv({ allow: false, ...BYPASS_ENV });
  env.RATE_LIMIT_ANALYTICS = {
    writeDataPoint(point) {
      writes.push(point);
    },
  };

  await captureEvents(() =>
    enforceEdgeRateLimit(
      apiRequest(RPC_PATH, { authorization: `Bearer ${API_TOKEN}` }),
      env,
      RPC_PATH,
      "api.shorted.com.au"
    )
  );

  assert.equal(writes.length, 1);
  const point = writes[0];
  assert.deepEqual(point.indexes, ["api-key"]);
  assert.deepEqual(point.blobs, [
    "limited", // blob1  decision
    "api-key", // blob2  bucket_class
    "api", // blob3  surface
    "10s", // blob4  window
    "token-hash", // blob5  key_type
    "", // blob6  bypass_class
    "shorts", // blob7  api_family
    "GetTopShorts", // blob8  rpc_method
    RPC_PATH, // blob9  path
    "POST", // blob10 method
    "", // blob11 cf_colo
  ]);
  assert.deepEqual(point.doubles, [100, 100, 600, 1]);

  // Analytics Engine limits: <=20 blobs, <=20 doubles, exactly 1 index, and an
  // index of at most 96 bytes.
  assert.ok(point.blobs.length <= 20);
  assert.ok(point.doubles.length <= 20);
  assert.equal(point.indexes.length, 1);
  assert.ok(new TextEncoder().encode(point.indexes[0]).length <= 96);

  // And the same leakage rule applies to the data point.
  const serialized = JSON.stringify(point);
  for (const secret of [API_TOKEN, CLIENT_IP, SSR_SECRET]) {
    assert.ok(!serialized.includes(secret), `data point leaked ${secret}`);
  }
});

test("a data point without a bucket class indexes as 'none', never empty", async () => {
  const writes = [];
  const env = bindingsEnv({ EDGE_RATE_LIMIT_SAMPLE_RATE: "1", ...BYPASS_ENV });
  env.RATE_LIMIT_ANALYTICS = { writeDataPoint: (p) => writes.push(p) };

  await captureEvents(() =>
    enforceEdgeRateLimit(
      apiRequest(RPC_PATH, {
        "user-agent": "Shorted-E2E/1.0",
        "x-shorted-testing-bypass": TESTING_SECRET,
      }),
      env,
      RPC_PATH,
      "api.shorted.com.au"
    )
  );

  assert.deepEqual(writes[0].indexes, ["none"]);
});

// ---------------------------------------------------------------------------
// edge_request gains additive rate limit fields
// ---------------------------------------------------------------------------

function analyticsEvent(response) {
  return buildEdgeAnalyticsEvent(apiRequest(), response, {
    origin: "shorts",
    cacheTtl: 0,
    started: 0,
    now: 5,
  });
}

test("edge_request marks an edge rate limit 429 with its bucket", () => {
  const response = new Response("{}", {
    status: 429,
    headers: {
      "X-Shorted-Cache": "RATELIMITED",
      "X-RateLimit-Scope": "edge-10s",
      "X-RateLimit-Bucket": "api-anon",
    },
  });
  const event = analyticsEvent(response);
  assert.equal(event.rate_limited, true);
  assert.equal(event.rate_limit_bucket, "api-anon");
});

test("edge_request does NOT mark an app-layer 429 as an edge rate limit", () => {
  // The Go API's own limiter: a 429 with an X-RateLimit-Detail, no edge scope.
  const response = new Response("{}", {
    status: 429,
    headers: {
      "X-Shorted-Cache": "BYPASS",
      "X-RateLimit-Detail": '{"kind":"monthly"}',
    },
  });
  const event = analyticsEvent(response);
  assert.equal(event.rate_limited, false);
  assert.equal(event.rate_limit_bucket, "");
});

test("edge_request rate limit fields are inert on an ordinary 200", () => {
  const response = new Response("{}", { status: 200, headers: { "X-Shorted-Cache": "HIT" } });
  const event = analyticsEvent(response);
  assert.equal(event.rate_limited, false);
  assert.equal(event.rate_limit_bucket, "");
  // The pre-existing contract is untouched.
  assert.equal(event.type, "edge_request");
  assert.equal(event.cache_status, "HIT");
  assert.equal(event.status, 200);
});
