import assert from "node:assert/strict";
import test from "node:test";

import worker, {
  buildRateLimitResponse,
  enforceEdgeRateLimit,
  extractRateLimitToken,
  resolveEdgeRateLimitKey,
  resolveRateLimitBypass,
} from "./worker.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/**
 * Mock of a Cloudflare Rate Limiting binding. The real binding exposes exactly
 * `limit({ key }) -> { success }`; nothing else is available (no remaining, no
 * reset), which is why the worker synthesizes its own Retry-After.
 */
function mockLimiter({ allow = true } = {}) {
  const calls = [];
  return {
    calls,
    async limit(options) {
      calls.push(options);
      return { success: typeof allow === "function" ? allow(options, calls) : allow };
    },
  };
}

function apiRequest(path = "/shorts.v1alpha1.MarketService/GetTopShorts", headers = {}) {
  return new Request(`https://api.shorted.com.au${path}`, {
    method: "POST",
    headers,
    body: "{}",
  });
}

const BYPASS_ENV = {
  RATE_LIMIT_TESTING_BYPASS_SECRET: "testing-secret-value-0123456789",
  RATE_LIMIT_TESTING_BYPASS_USER_AGENT: "Shorted-E2E",
  RATE_LIMIT_TESTING_BYPASS_HEADER_NAME: "x-shorted-testing-bypass",
  RATE_LIMIT_SSR_BYPASS_SECRET: "ssr-secret-value-9876543210abc",
  RATE_LIMIT_SSR_BYPASS_USER_AGENT: "shorted-web-ssr",
  RATE_LIMIT_SSR_BYPASS_HEADER_NAME: "x-shorted-ssr-bypass",
};

// ---------------------------------------------------------------------------
// Token extraction
// ---------------------------------------------------------------------------

test("extractRateLimitToken reads bearer, bare Authorization, and x-api-key", () => {
  assert.equal(
    extractRateLimitToken(apiRequest("/x", { authorization: "Bearer abc123" })),
    "abc123"
  );
  assert.equal(
    extractRateLimitToken(apiRequest("/x", { authorization: "bearer   abc123  " })),
    "abc123"
  );
  assert.equal(extractRateLimitToken(apiRequest("/x", { authorization: "abc123" })), "abc123");
  assert.equal(extractRateLimitToken(apiRequest("/x", { "x-api-key": "key-9" })), "key-9");
  assert.equal(extractRateLimitToken(apiRequest("/x")), "");
});

test("x-api-key wins over Authorization so one caller cannot occupy two buckets", () => {
  const request = apiRequest("/x", { "x-api-key": "key-9", authorization: "Bearer other" });
  assert.equal(extractRateLimitToken(request), "key-9");
});

// ---------------------------------------------------------------------------
// Bucket selection + keying
// ---------------------------------------------------------------------------

test("authenticated requests use the per-token bucket and never leak the raw token", async () => {
  const token = "sk_live_supersecrettoken";
  const resolved = await resolveEdgeRateLimitKey(apiRequest("/x", { authorization: `Bearer ${token}` }));

  assert.equal(resolved.bucket, "key");
  assert.equal(resolved.limit, 120);
  assert.match(resolved.key, /^k:[0-9a-f]{32}$/);
  assert.ok(!resolved.key.includes(token), "the raw credential must never appear in a rate limit key");
});

test("the same token always hashes to the same key, different tokens do not collide", async () => {
  const a = await resolveEdgeRateLimitKey(apiRequest("/x", { authorization: "Bearer aaa" }));
  const b = await resolveEdgeRateLimitKey(apiRequest("/x", { authorization: "Bearer aaa" }));
  const c = await resolveEdgeRateLimitKey(apiRequest("/x", { authorization: "Bearer bbb" }));

  assert.equal(a.key, b.key);
  assert.notEqual(a.key, c.key);
});

test("unauthenticated requests fall back to the stricter per-IP anonymous bucket", async () => {
  const resolved = await resolveEdgeRateLimitKey(apiRequest("/x", { "cf-connecting-ip": "203.0.113.9" }));

  assert.equal(resolved.bucket, "anon");
  assert.equal(resolved.limit, 30);
  assert.equal(resolved.key, "a:203.0.113.9");
});

test("token and IP keys are namespaced so they can never collide", async () => {
  const tokenKey = (await resolveEdgeRateLimitKey(apiRequest("/x", { authorization: "Bearer t" }))).key;
  const ipKey = (await resolveEdgeRateLimitKey(apiRequest("/x", { "cf-connecting-ip": "1.2.3.4" }))).key;

  assert.ok(tokenKey.startsWith("k:"));
  assert.ok(ipKey.startsWith("a:"));
});

test("x-forwarded-for uses the rightmost (proxy-appended) IP, not the spoofable leftmost", async () => {
  const resolved = await resolveEdgeRateLimitKey(
    apiRequest("/x", { "x-forwarded-for": "9.9.9.9, 203.0.113.9" })
  );
  assert.equal(resolved.key, "a:203.0.113.9");
});

test("limits are configurable from worker vars so Terraform stays the single source of truth", async () => {
  const env = { RATE_LIMIT_KEY_LIMIT: "300", RATE_LIMIT_ANON_LIMIT: "10" };

  const keyed = await resolveEdgeRateLimitKey(apiRequest("/x", { authorization: "Bearer t" }), env);
  const anon = await resolveEdgeRateLimitKey(apiRequest("/x"), env);

  assert.equal(keyed.limit, 300);
  assert.equal(anon.limit, 10);
});

// ---------------------------------------------------------------------------
// Bypass parity with the zone skip rules
// ---------------------------------------------------------------------------

test("E2E bypass requires BOTH the user-agent marker and the exact secret", () => {
  const bothPresent = apiRequest("/x", {
    "user-agent": "Shorted-E2E/1.0",
    "x-shorted-testing-bypass": BYPASS_ENV.RATE_LIMIT_TESTING_BYPASS_SECRET,
  });
  assert.equal(resolveRateLimitBypass(bothPresent, BYPASS_ENV), "testing");

  const uaOnly = apiRequest("/x", { "user-agent": "Shorted-E2E/1.0" });
  assert.equal(resolveRateLimitBypass(uaOnly, BYPASS_ENV), "", "UA alone must never bypass");

  const secretOnly = apiRequest("/x", {
    "user-agent": "Mozilla/5.0",
    "x-shorted-testing-bypass": BYPASS_ENV.RATE_LIMIT_TESTING_BYPASS_SECRET,
  });
  assert.equal(resolveRateLimitBypass(secretOnly, BYPASS_ENV), "", "secret alone must never bypass");

  const wrongSecret = apiRequest("/x", {
    "user-agent": "Shorted-E2E/1.0",
    "x-shorted-testing-bypass": "not-the-secret-not-the-secret1",
  });
  assert.equal(resolveRateLimitBypass(wrongSecret, BYPASS_ENV), "");
});

test("first-party SSR bypass requires BOTH the shorted-web-ssr marker and the secret", () => {
  const request = apiRequest("/x", {
    "user-agent": "shorted-web-ssr/1.0",
    "x-shorted-ssr-bypass": BYPASS_ENV.RATE_LIMIT_SSR_BYPASS_SECRET,
  });
  assert.equal(resolveRateLimitBypass(request, BYPASS_ENV), "ssr");

  const uaOnly = apiRequest("/x", { "user-agent": "shorted-web-ssr/1.0" });
  assert.equal(resolveRateLimitBypass(uaOnly, BYPASS_ENV), "");
});

test("an unset secret disables that bypass class entirely", () => {
  const env = { ...BYPASS_ENV, EDGE_RATE_LIMIT_ENABLED: "true", RATE_LIMIT_SSR_BYPASS_SECRET: "" };
  const request = apiRequest("/x", {
    "user-agent": "shorted-web-ssr/1.0",
    "x-shorted-ssr-bypass": "",
  });
  assert.equal(resolveRateLimitBypass(request, env), "");
});

test("bypassed traffic is not rate limited even when the bucket is exhausted", async () => {
  const limiter = mockLimiter({ allow: false });
  const env = { ...BYPASS_ENV, EDGE_RATE_LIMIT_ENABLED: "true", API_KEY_RATE_LIMITER: limiter, ANON_RATE_LIMITER: limiter };
  const request = apiRequest("/x", {
    "user-agent": "shorted-web-ssr/1.0",
    "x-shorted-ssr-bypass": BYPASS_ENV.RATE_LIMIT_SSR_BYPASS_SECRET,
  });

  assert.equal(await enforceEdgeRateLimit(request, env, "/x"), null);
  assert.equal(limiter.calls.length, 0, "a bypassed request must not even consume a token");
});

// ---------------------------------------------------------------------------
// Enforcement
// ---------------------------------------------------------------------------

test("an allowed request passes through and consumes exactly one token", async () => {
  const keyed = mockLimiter();
  const anon = mockLimiter();
  const env = { EDGE_RATE_LIMIT_ENABLED: "true", API_KEY_RATE_LIMITER: keyed, ANON_RATE_LIMITER: anon };

  const result = await enforceEdgeRateLimit(
    apiRequest("/x", { authorization: "Bearer abc" }),
    env,
    "/x"
  );

  assert.equal(result, null);
  assert.equal(keyed.calls.length, 1);
  assert.equal(anon.calls.length, 0, "an authenticated request must not also hit the anonymous bucket");
});

test("an unauthenticated request consumes only the anonymous bucket", async () => {
  const keyed = mockLimiter();
  const anon = mockLimiter();
  const env = { EDGE_RATE_LIMIT_ENABLED: "true", API_KEY_RATE_LIMITER: keyed, ANON_RATE_LIMITER: anon };

  await enforceEdgeRateLimit(apiRequest("/x", { "cf-connecting-ip": "1.1.1.1" }), env, "/x");

  assert.equal(anon.calls.length, 1);
  assert.equal(anon.calls[0].key, "a:1.1.1.1");
  assert.equal(keyed.calls.length, 0);
});

test("an exhausted bucket returns 429 with the app layer's header contract", async () => {
  const env = { EDGE_RATE_LIMIT_ENABLED: "true", ANON_RATE_LIMITER: mockLimiter({ allow: false }) };
  const response = await enforceEdgeRateLimit(apiRequest("/x"), env, "/x");

  assert.ok(response, "an exhausted bucket must reject");
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "60");
  assert.equal(response.headers.get("X-RateLimit-Limit"), "30");
  assert.equal(response.headers.get("X-RateLimit-Remaining"), "0");
  assert.equal(response.headers.get("X-RateLimit-Scope"), "edge-minute");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("X-Shorted-Cache"), "RATELIMITED");
  assert.equal(response.headers.get("X-Shorted-Edge"), "cloudflare");

  const reset = parseInt(response.headers.get("X-RateLimit-Reset"), 10);
  const now = Math.floor(Date.now() / 1000);
  assert.ok(reset > now && reset <= now + 61, `reset ${reset} should be ~60s ahead of ${now}`);
});

test("RPC paths get a Connect-shaped error envelope, other paths get the zone-rule shape", async () => {
  const rpc = await buildRateLimitResponse(
    "/shorts.v1alpha1.MarketService/GetTopShorts",
    120
  ).json();
  assert.equal(rpc.code, "resource_exhausted");
  assert.match(rpc.message, /120 requests per minute/);

  const plain = await buildRateLimitResponse("/edge/v1/top-shorts", 30).json();
  assert.equal(plain.error, "Too Many Requests");
});

test("health checks are never rate limited", async () => {
  const limiter = mockLimiter({ allow: false });
  const env = { API_KEY_RATE_LIMITER: limiter, ANON_RATE_LIMITER: limiter };

  assert.equal(await enforceEdgeRateLimit(apiRequest("/health"), env, "/health"), null);
  assert.equal(await enforceEdgeRateLimit(apiRequest("/healthz"), env, "/healthz"), null);
  assert.equal(limiter.calls.length, 0);
});

test("an absent enable flag means DISABLED — enforcement is opt-in", async () => {
  // Deploy-order safety: anonymous browser traffic reaches the worker via the
  // Vercel rewrite proxy (shared egress IPs), so enforcement must never turn
  // on implicitly. See enforceEdgeRateLimit's comment.
  const limiter = mockLimiter({ allow: false });
  const env = { API_KEY_RATE_LIMITER: limiter, ANON_RATE_LIMITER: limiter };
  assert.equal(await enforceEdgeRateLimit(apiRequest("/x"), env, "/x"), null);
  assert.equal(limiter.calls.length, 0);
});

test("EDGE_RATE_LIMIT_ENABLED=false is a kill switch", async () => {
  const limiter = mockLimiter({ allow: false });
  const env = {
    EDGE_RATE_LIMIT_ENABLED: "false",
    API_KEY_RATE_LIMITER: limiter,
    ANON_RATE_LIMITER: limiter,
  };

  assert.equal(await enforceEdgeRateLimit(apiRequest("/x"), env, "/x"), null);
  assert.equal(limiter.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Fail-open behaviour — rate limiting must never be the reason the API is down
// ---------------------------------------------------------------------------

test("a missing binding fails open", async () => {
  assert.equal(await enforceEdgeRateLimit(apiRequest("/x"), {}, "/x"), null);
});

test("a binding that throws fails open", async () => {
  const env = {
    EDGE_RATE_LIMIT_ENABLED: "true",
    ANON_RATE_LIMITER: {
      async limit() {
        throw new Error("binding exploded");
      },
    },
  };
  assert.equal(await enforceEdgeRateLimit(apiRequest("/x"), env, "/x"), null);
});

test("a binding returning a malformed outcome fails open", async () => {
  const env = {
    EDGE_RATE_LIMIT_ENABLED: "true",
    ANON_RATE_LIMITER: {
      async limit() {
        return undefined;
      },
    },
  };
  assert.equal(await enforceEdgeRateLimit(apiRequest("/x"), env, "/x"), null);
});

// ---------------------------------------------------------------------------
// Integration through worker.fetch
// ---------------------------------------------------------------------------

test("worker.fetch short-circuits a limited API request before any origin fetch", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  let originCalls = 0;

  globalThis.caches = { default: { async match() {}, async put() {} } };
  globalThis.fetch = async () => {
    originCalls++;
    return new Response("{}", { status: 200 });
  };

  try {
    const env = {
      SHORTS_API_ORIGIN: "https://shorts-origin.test",
      EDGE_ANALYTICS_SAMPLE_RATE: "0",
      EDGE_RATE_LIMIT_ENABLED: "true",
      ANON_RATE_LIMITER: mockLimiter({ allow: false }),
    };

    const response = await worker.fetch(
      apiRequest("/shorts.v1alpha1.MarketService/GetTopShorts", { "cf-connecting-ip": "1.2.3.4" }),
      env,
      { waitUntil() {} }
    );

    assert.equal(response.status, 429);
    assert.equal(originCalls, 0, "a limited request must cost the origin nothing");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
  }
});

test("worker.fetch leaves frontend traffic alone — it is protected by the zone rules", async () => {
  const originalFetch = globalThis.fetch;
  const limiter = mockLimiter({ allow: false });
  globalThis.fetch = async () => new Response("<html></html>", { status: 200 });

  try {
    const env = {
      SHORTS_API_ORIGIN: "https://shorts-origin.test",
      EDGE_ANALYTICS_SAMPLE_RATE: "0",
      API_KEY_RATE_LIMITER: limiter,
      ANON_RATE_LIMITER: limiter,
    };

    const response = await worker.fetch(
      new Request("https://shorted.com.au/top", { headers: { "cf-connecting-ip": "1.2.3.4" } }),
      env,
      { waitUntil() {} }
    );

    assert.equal(response.status, 200);
    assert.equal(limiter.calls.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker.fetch keeps serving an allowed API request through the cache path", async () => {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  let originCalls = 0;

  globalThis.caches = { default: { async match() {}, async put() {} } };
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  try {
    const limiter = mockLimiter({ allow: true });
    const env = {
      SHORTS_API_ORIGIN: "https://shorts-origin.test",
      EDGE_ANALYTICS_SAMPLE_RATE: "0",
      EDGE_RATE_LIMIT_ENABLED: "true",
      API_KEY_RATE_LIMITER: limiter,
    };

    const response = await worker.fetch(
      apiRequest("/shorts.v1alpha1.MarketService/GetTopShorts", { authorization: "Bearer tok" }),
      env,
      { waitUntil() {} }
    );

    assert.equal(response.status, 200);
    assert.equal(originCalls, 0);
    assert.equal(limiter.calls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
  }
});
