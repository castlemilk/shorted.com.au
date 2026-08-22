import assert from "node:assert/strict";
import test from "node:test";

import worker, {
  buildRateLimitResponse,
  enforceEdgeRateLimit,
  extractRateLimitToken,
  extractSessionCookie,
  isRateLimitEligiblePath,
  isVerifiedCrawler,
  resolveBucketLimits,
  resolveEdgeRateLimitKey,
  resolveRateLimitBypass,
  resolveRateLimitSurface,
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

const RPC_PATH = "/shorts.v1alpha1.MarketService/GetTopShorts";

function apiRequest(path = RPC_PATH, headers = {}) {
  return new Request(`https://api.shorted.com.au${path}`, {
    method: "POST",
    headers,
    body: "{}",
  });
}

function browserRequest(path = RPC_PATH, headers = {}) {
  return new Request(`https://shorted.com.au${path}`, { headers });
}

const BYPASS_ENV = {
  RATE_LIMIT_TESTING_BYPASS_SECRET: "testing-secret-value-0123456789",
  RATE_LIMIT_TESTING_BYPASS_USER_AGENT: "Shorted-E2E",
  RATE_LIMIT_TESTING_BYPASS_HEADER_NAME: "x-shorted-testing-bypass",
  RATE_LIMIT_SSR_BYPASS_SECRET: "ssr-secret-value-9876543210abc",
  RATE_LIMIT_SSR_BYPASS_USER_AGENT: "shorted-web-ssr",
  RATE_LIMIT_SSR_BYPASS_HEADER_NAME: "x-shorted-ssr-bypass",
};

/** Every binding name the worker knows about, wired to one shared mock. */
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

/** Build an env with a separate mock limiter per binding, plus a lookup map. */
function bindingsEnv({ allow = true, ...rest } = {}) {
  const limiters = {};
  const env = { EDGE_RATE_LIMIT_ENABLED: "true", ...rest };
  for (const name of BINDING_NAMES) {
    limiters[name] = mockLimiter({ allow });
    env[name] = limiters[name];
  }
  return { env, limiters };
}

/** Total limiter calls across every binding except the named ones. */
function callsExcept(limiters, ...names) {
  return BINDING_NAMES.filter((n) => !names.includes(n)).reduce(
    (total, n) => total + limiters[n].calls.length,
    0
  );
}

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
// Session cookie extraction (the browser signed-in key)
// ---------------------------------------------------------------------------

test("extractSessionCookie reads the production __Secure- cookie and the dev cookie", () => {
  assert.equal(
    extractSessionCookie(
      browserRequest("/x", { cookie: "a=1; __Secure-next-auth.session-token=prod-jwt; b=2" })
    ),
    "prod-jwt"
  );
  assert.equal(
    extractSessionCookie(browserRequest("/x", { cookie: "next-auth.session-token=dev-jwt" })),
    "dev-jwt"
  );
  assert.equal(extractSessionCookie(browserRequest("/x", { cookie: "theme=dark" })), "");
  assert.equal(extractSessionCookie(browserRequest("/x")), "");
});

test("a CHUNKED next-auth session cookie is reassembled, not treated as anonymous", () => {
  // next-auth splits a large session JWT into .0/.1/... — missing this would
  // silently drop signed-in users into the anonymous bucket.
  const request = browserRequest("/x", {
    cookie: "__Secure-next-auth.session-token.0=head; __Secure-next-auth.session-token.1=tail",
  });
  assert.equal(extractSessionCookie(request), "headtail");
});

// ---------------------------------------------------------------------------
// Surface routing
// ---------------------------------------------------------------------------

test("the worker distinguishes its two routes — only shorted.com.au is the browser surface", () => {
  assert.equal(resolveRateLimitSurface("shorted.com.au"), "browser");
  assert.equal(resolveRateLimitSurface("www.shorted.com.au"), "browser");
  assert.equal(resolveRateLimitSurface("api.shorted.com.au"), "api");
});

// ---------------------------------------------------------------------------
// Path scoping
// ---------------------------------------------------------------------------

test("HTML page routes on the browser surface are NEVER rate limited", () => {
  for (const path of ["/", "/top", "/shorts/BHP", "/housing/nsw/bondi", "/reports/weekly/x"]) {
    assert.equal(
      isRateLimitEligiblePath("browser", path),
      false,
      `${path} is a document route and must never be limited`
    );
  }
});

test("static assets and Next.js chunks on the browser surface are never limited", () => {
  for (const path of ["/_next/static/chunks/main.js", "/favicon.ico", "/images/logo.svg"]) {
    assert.equal(isRateLimitEligiblePath("browser", path), false, path);
  }
});

test("API-ish browser paths ARE eligible — the middleware list plus the rewrite prefixes", () => {
  for (const path of [
    "/api/market-data/historical",
    "/api/search/stocks",
    "/api/community/threads",
    "/api/stripe/checkout",
    "/api/stripe/portal",
    "/api/stocks/BHP",
    "/api/algolia/search",
    "/edge/v1/top-shorts",
    "/chat.v1.ChatService/SendMessage",
    "/register.v1.RegisterService/ListPoliticians",
    RPC_PATH,
    "/shorts.v1alpha1.HousingService/ListSuburbs",
  ]) {
    assert.equal(isRateLimitEligiblePath("browser", path), true, path);
  }
});

test("/api/auth/* is exempt on BOTH surfaces — it fires on every page load", () => {
  // 2 of the 9 limitable requests on /shorts/BHP are session calls. Limiting
  // them would break sign-in state during ordinary browsing.
  for (const surface of ["browser", "api"]) {
    assert.equal(isRateLimitEligiblePath(surface, "/api/auth/session"), false);
    assert.equal(isRateLimitEligiblePath(surface, "/api/auth/csrf"), false);
  }
});

test("health checks are exempt on both surfaces", () => {
  for (const surface of ["browser", "api"]) {
    assert.equal(isRateLimitEligiblePath(surface, "/health"), false);
    assert.equal(isRateLimitEligiblePath(surface, "/healthz"), false);
  }
});

test("the API host serves nothing but API traffic, so everything else there is eligible", () => {
  assert.equal(isRateLimitEligiblePath("api", RPC_PATH), true);
  assert.equal(isRateLimitEligiblePath("api", "/api/anything"), true);
});

// ---------------------------------------------------------------------------
// Verified search crawlers — SEO is the product
// ---------------------------------------------------------------------------

test("a Bot-Management-verified bot is recognised, and an unverified one is not", () => {
  const verified = browserRequest("/api/search/stocks");
  Object.defineProperty(verified, "cf", { value: { botManagement: { verifiedBot: true } } });
  assert.equal(isVerifiedCrawler(verified), true);

  const unverified = browserRequest("/api/search/stocks", { "user-agent": "Googlebot/2.1" });
  Object.defineProperty(unverified, "cf", { value: { botManagement: { verifiedBot: false } } });
  assert.equal(
    isVerifiedCrawler(unverified),
    false,
    "a real verifiedBot=false signal must beat a spoofable UA"
  );
});

test("without Bot Management the crawler UA is trusted — the SEO-safe error", () => {
  for (const ua of ["Googlebot/2.1", "bingbot/2.0", "GPTBot/1.0", "PerplexityBot"]) {
    assert.equal(isVerifiedCrawler(browserRequest("/api/search/stocks", { "user-agent": ua })), true, ua);
  }
  assert.equal(
    isVerifiedCrawler(browserRequest("/api/search/stocks", { "user-agent": "Mozilla/5.0" })),
    false
  );
});

test("EDGE_RATE_LIMIT_TRUST_CRAWLER_UA=false requires a real verifiedBot signal", () => {
  const request = browserRequest("/api/search/stocks", { "user-agent": "Googlebot/2.1" });
  assert.equal(isVerifiedCrawler(request, { EDGE_RATE_LIMIT_TRUST_CRAWLER_UA: "false" }), false);
});

test("a verified crawler consumes no bucket even when every bucket is exhausted", async () => {
  const { env, limiters } = bindingsEnv({ allow: false });
  const request = browserRequest("/api/search/stocks", { "user-agent": "Googlebot/2.1" });

  assert.equal(
    await enforceEdgeRateLimit(request, env, "/api/search/stocks", "shorted.com.au"),
    null
  );
  assert.equal(callsExcept(limiters), 0, "a 429 to Googlebot is a crawl-rate penalty, not a throttle");
});

// ---------------------------------------------------------------------------
// Bucket selection + keying
// ---------------------------------------------------------------------------

test("authenticated API requests use the per-token bucket and never leak the raw token", async () => {
  const token = "sk_live_supersecrettoken";
  const resolved = await resolveEdgeRateLimitKey(
    apiRequest("/x", { authorization: `Bearer ${token}` }),
    {},
    "api"
  );

  assert.equal(resolved.bucketClass, "api-key");
  assert.match(resolved.key, /^k:[0-9a-f]{32}$/);
  assert.ok(!resolved.key.includes(token), "the raw credential must never appear in a rate limit key");
});

test("the same token always hashes to the same key, different tokens do not collide", async () => {
  const a = await resolveEdgeRateLimitKey(apiRequest("/x", { authorization: "Bearer aaa" }), {}, "api");
  const b = await resolveEdgeRateLimitKey(apiRequest("/x", { authorization: "Bearer aaa" }), {}, "api");
  const c = await resolveEdgeRateLimitKey(apiRequest("/x", { authorization: "Bearer bbb" }), {}, "api");

  assert.equal(a.key, b.key);
  assert.notEqual(a.key, c.key);
});

test("unauthenticated API requests fall back to the per-IP anonymous bucket", async () => {
  const resolved = await resolveEdgeRateLimitKey(
    apiRequest("/x", { "cf-connecting-ip": "203.0.113.9" }),
    {},
    "api"
  );

  assert.equal(resolved.bucketClass, "api-anon");
  assert.equal(resolved.key, "a:203.0.113.9");
});

test("first-party traffic takes the runaway bucket, NOT the shared-egress anon bucket", async () => {
  // This is the whole point of the identity work: without it every anonymous
  // browser behind the Vercel rewrite collapses onto a handful of egress IPs.
  const resolved = await resolveEdgeRateLimitKey(
    apiRequest("/x", { "cf-connecting-ip": "76.76.21.21" }),
    {},
    "api",
    "ssr"
  );

  assert.equal(resolved.bucketClass, "first-party");
  assert.equal(resolved.key, "f:76.76.21.21");
});

test("a first-party marker on a request that ALSO carries a token still means first-party", async () => {
  const resolved = await resolveEdgeRateLimitKey(
    apiRequest("/x", { authorization: "Bearer t", "cf-connecting-ip": "76.76.21.21" }),
    {},
    "api",
    "ssr"
  );
  assert.equal(resolved.bucketClass, "first-party");
});

test("browser requests key on the SESSION when signed in, and on the real IP when not", async () => {
  const signedIn = await resolveEdgeRateLimitKey(
    browserRequest("/x", {
      cookie: "__Secure-next-auth.session-token=jwt-value",
      "cf-connecting-ip": "198.51.100.7",
    }),
    {},
    "browser"
  );
  assert.equal(signedIn.bucketClass, "browser-auth");
  assert.match(signedIn.key, /^bu:[0-9a-f]{32}$/);
  assert.ok(!signedIn.key.includes("198.51.100.7"), "a signed-in user must not be keyed by IP");
  assert.ok(!signedIn.key.includes("jwt-value"), "the raw session must never enter a key");

  const anon = await resolveEdgeRateLimitKey(
    browserRequest("/x", { "cf-connecting-ip": "198.51.100.7" }),
    {},
    "browser"
  );
  assert.equal(anon.bucketClass, "browser-anon");
  assert.equal(anon.key, "ba:198.51.100.7");
});

test("two colleagues behind one office IP get separate signed-in buckets", async () => {
  const a = await resolveEdgeRateLimitKey(
    browserRequest("/x", { cookie: "next-auth.session-token=alice", "cf-connecting-ip": "1.1.1.1" }),
    {},
    "browser"
  );
  const b = await resolveEdgeRateLimitKey(
    browserRequest("/x", { cookie: "next-auth.session-token=bob", "cf-connecting-ip": "1.1.1.1" }),
    {},
    "browser"
  );
  assert.notEqual(a.key, b.key);
});

test("every bucket class uses a distinct key prefix so keys can never collide", async () => {
  const keys = await Promise.all([
    resolveEdgeRateLimitKey(apiRequest("/x", { authorization: "Bearer t" }), {}, "api"),
    resolveEdgeRateLimitKey(apiRequest("/x", { "cf-connecting-ip": "1.2.3.4" }), {}, "api"),
    resolveEdgeRateLimitKey(apiRequest("/x", { "cf-connecting-ip": "1.2.3.4" }), {}, "api", "ssr"),
    resolveEdgeRateLimitKey(browserRequest("/x", { "cf-connecting-ip": "1.2.3.4" }), {}, "browser"),
    resolveEdgeRateLimitKey(
      browserRequest("/x", { cookie: "next-auth.session-token=s" }),
      {},
      "browser"
    ),
  ]);

  const prefixes = keys.map((k) => k.key.split(":")[0]);
  assert.deepEqual(prefixes, ["k", "a", "f", "ba", "bu"]);
  assert.equal(new Set(prefixes).size, prefixes.length);
});

test("x-forwarded-for uses the rightmost (proxy-appended) IP, not the spoofable leftmost", async () => {
  const resolved = await resolveEdgeRateLimitKey(
    apiRequest("/x", { "x-forwarded-for": "9.9.9.9, 203.0.113.9" }),
    {},
    "api"
  );
  assert.equal(resolved.key, "a:203.0.113.9");
});

// ---------------------------------------------------------------------------
// The bucket matrix as configured
// ---------------------------------------------------------------------------

test("the compiled-in defaults are the measured matrix", () => {
  const expected = {
    "api-key": [100, 600],
    "api-anon": [10, 30],
    "first-party": [600, 0],
    "browser-anon": [100, 600],
    "browser-auth": [200, 1200],
  };

  for (const [bucketClass, [burst, sustained]] of Object.entries(expected)) {
    const limits = resolveBucketLimits(bucketClass, {});
    assert.ok(limits, bucketClass);
    assert.equal(limits.burstLimit, burst, `${bucketClass} burst`);
    assert.equal(limits.sustainedLimit, sustained, `${bucketClass} sustained`);
  }
});

test("the browser buckets clear the measured worst-case browsing load with headroom", () => {
  // Measured on prod with Playwright, logged out: /shorts/BHP costs 9 limitable
  // requests, so the worst realistic human burst (4 stock pages in 10s) is 36,
  // and the hardest minute (15 pages) is 135. A real reader must never be 429'd.
  const worstBurst = 4 * 9;
  const worstMinute = 15 * 9;

  const anon = resolveBucketLimits("browser-anon", {});
  assert.ok(anon.burstLimit >= worstBurst * 2, `${anon.burstLimit} must clear ${worstBurst} with margin`);
  assert.ok(anon.sustainedLimit >= worstMinute * 2, `${anon.sustainedLimit} must clear ${worstMinute}`);

  const auth = resolveBucketLimits("browser-auth", {});
  assert.ok(auth.burstLimit >= anon.burstLimit);
  assert.ok(auth.sustainedLimit >= anon.sustainedLimit);
});

test("the API token ceiling does not throttle the documented per-minute-unlimited paid tier", () => {
  // 600/60s = 10 req/s sustained. Anything at or below the old 120 would have
  // throttled a paying customer doing a legitimate bulk pull.
  const limits = resolveBucketLimits("api-key", {});
  assert.ok(limits.sustainedLimit >= 600);
});

test("every number is overridable from worker vars so Terraform stays the source of truth", () => {
  const env = {
    RATE_LIMIT_KEY_BURST: "7",
    RATE_LIMIT_KEY_LIMIT: "300",
    RATE_LIMIT_ANON_BURST: "3",
    RATE_LIMIT_ANON_LIMIT: "10",
    RATE_LIMIT_FIRST_PARTY_BURST: "999",
    RATE_LIMIT_BROWSER_ANON_BURST: "11",
    RATE_LIMIT_BROWSER_ANON_LIMIT: "22",
    RATE_LIMIT_BROWSER_AUTH_BURST: "33",
    RATE_LIMIT_BROWSER_AUTH_LIMIT: "44",
  };

  assert.deepEqual(
    ["api-key", "api-anon", "first-party", "browser-anon", "browser-auth"].map((c) => {
      const l = resolveBucketLimits(c, env);
      return [l.burstLimit, l.sustainedLimit];
    }),
    [
      [7, 300],
      [3, 10],
      [999, 0],
      [11, 22],
      [33, 44],
    ]
  );
});

test("an unknown bucket class resolves to null rather than inventing a limit", () => {
  assert.equal(resolveBucketLimits("nonsense", {}), null);
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

test("first-party SSR marker requires BOTH the shorted-web-ssr marker and the secret", () => {
  const request = apiRequest("/x", {
    "user-agent": "shorted-web-ssr/1.0",
    "x-shorted-ssr-bypass": BYPASS_ENV.RATE_LIMIT_SSR_BYPASS_SECRET,
  });
  assert.equal(resolveRateLimitBypass(request, BYPASS_ENV), "ssr");

  const uaOnly = apiRequest("/x", { "user-agent": "shorted-web-ssr/1.0" });
  assert.equal(resolveRateLimitBypass(uaOnly, BYPASS_ENV), "");
});

test("the middleware's appended-UA shape is recognised as first-party", () => {
  // web/src/middleware.ts appends the marker rather than replacing the UA, so
  // the real client UA survives for downstream bot detection.
  const request = apiRequest("/x", {
    "user-agent": "Mozilla/5.0 (Macintosh) Chrome/140 shorted-web-ssr/1.0 (+https://shorted.com.au)",
    "x-shorted-ssr-bypass": BYPASS_ENV.RATE_LIMIT_SSR_BYPASS_SECRET,
  });
  assert.equal(resolveRateLimitBypass(request, BYPASS_ENV), "ssr");
});

test("an unset secret disables that bypass class entirely", () => {
  const env = { ...BYPASS_ENV, RATE_LIMIT_SSR_BYPASS_SECRET: "" };
  const request = apiRequest("/x", { "user-agent": "shorted-web-ssr/1.0", "x-shorted-ssr-bypass": "" });
  assert.equal(resolveRateLimitBypass(request, env), "");
});

test("E2E traffic skips every bucket; first-party traffic is routed, not skipped", async () => {
  const testing = bindingsEnv({ allow: false, ...BYPASS_ENV });
  assert.equal(
    await enforceEdgeRateLimit(
      apiRequest("/x", {
        "user-agent": "Shorted-E2E/1.0",
        "x-shorted-testing-bypass": BYPASS_ENV.RATE_LIMIT_TESTING_BYPASS_SECRET,
      }),
      testing.env,
      "/x"
    ),
    null
  );
  assert.equal(callsExcept(testing.limiters), 0, "trusted test traffic must not even consume a token");

  const ssr = bindingsEnv({ allow: true, ...BYPASS_ENV });
  await enforceEdgeRateLimit(
    apiRequest("/x", {
      "user-agent": "shorted-web-ssr/1.0",
      "x-shorted-ssr-bypass": BYPASS_ENV.RATE_LIMIT_SSR_BYPASS_SECRET,
      "cf-connecting-ip": "76.76.21.21",
    }),
    ssr.env,
    "/x"
  );
  assert.equal(ssr.limiters.FIRST_PARTY_RATE_LIMITER.calls.length, 1);
  assert.equal(ssr.limiters.ANON_RATE_LIMITER.calls.length, 0, "first-party must never touch the anon bucket");
  assert.equal(ssr.limiters.ANON_BURST_RATE_LIMITER.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Enforcement — burst / sustained precedence
// ---------------------------------------------------------------------------

test("an allowed request consumes exactly one token from BOTH windows of its class", async () => {
  const { env, limiters } = bindingsEnv();

  const result = await enforceEdgeRateLimit(apiRequest("/x", { authorization: "Bearer abc" }), env, "/x");

  assert.equal(result, null);
  assert.equal(limiters.API_KEY_BURST_RATE_LIMITER.calls.length, 1);
  assert.equal(limiters.API_KEY_RATE_LIMITER.calls.length, 1);
  assert.equal(
    callsExcept(limiters, "API_KEY_BURST_RATE_LIMITER", "API_KEY_RATE_LIMITER"),
    0,
    "no other class may be charged"
  );
  assert.equal(
    limiters.API_KEY_BURST_RATE_LIMITER.calls[0].key,
    limiters.API_KEY_RATE_LIMITER.calls[0].key,
    "both windows must count the same identity"
  );
});

test("burst is evaluated FIRST and short-circuits the sustained window", async () => {
  const { env, limiters } = bindingsEnv();
  env.ANON_BURST_RATE_LIMITER = mockLimiter({ allow: false });
  limiters.ANON_BURST_RATE_LIMITER = env.ANON_BURST_RATE_LIMITER;

  const response = await enforceEdgeRateLimit(apiRequest("/x", { "cf-connecting-ip": "1.1.1.1" }), env, "/x");

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "10", "a burst 429 must say 10s, not 60s");
  assert.equal(response.headers.get("X-RateLimit-Limit"), "10");
  assert.equal(response.headers.get("X-RateLimit-Scope"), "edge-10s");
  assert.equal(
    limiters.ANON_RATE_LIMITER.calls.length,
    0,
    "the sustained window must not be charged once burst has already rejected"
  );
});

test("a slow grind that clears the burst window is still caught by the sustained window", async () => {
  const { env, limiters } = bindingsEnv();
  env.ANON_RATE_LIMITER = mockLimiter({ allow: false });
  limiters.ANON_RATE_LIMITER = env.ANON_RATE_LIMITER;

  const response = await enforceEdgeRateLimit(apiRequest("/x", { "cf-connecting-ip": "1.1.1.1" }), env, "/x");

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "60");
  assert.equal(response.headers.get("X-RateLimit-Limit"), "30");
  assert.equal(response.headers.get("X-RateLimit-Scope"), "edge-60s");
  assert.equal(limiters.ANON_BURST_RATE_LIMITER.calls.length, 1);
});

test("the first-party class has no sustained window and never consults one", async () => {
  const { env, limiters } = bindingsEnv({ ...BYPASS_ENV });
  const response = await enforceEdgeRateLimit(
    apiRequest("/x", {
      "user-agent": "shorted-web-ssr/1.0",
      "x-shorted-ssr-bypass": BYPASS_ENV.RATE_LIMIT_SSR_BYPASS_SECRET,
    }),
    env,
    "/x"
  );

  assert.equal(response, null);
  assert.equal(limiters.FIRST_PARTY_RATE_LIMITER.calls.length, 1);
  assert.equal(callsExcept(limiters, "FIRST_PARTY_RATE_LIMITER"), 0);
});

test("browser traffic is charged to the browser buckets, never the API ones", async () => {
  const anon = bindingsEnv();
  await enforceEdgeRateLimit(
    browserRequest("/api/search/stocks", { "cf-connecting-ip": "198.51.100.7" }),
    anon.env,
    "/api/search/stocks",
    "shorted.com.au"
  );
  assert.equal(anon.limiters.BROWSER_ANON_BURST_RATE_LIMITER.calls.length, 1);
  assert.equal(anon.limiters.BROWSER_ANON_RATE_LIMITER.calls.length, 1);
  assert.equal(
    callsExcept(anon.limiters, "BROWSER_ANON_BURST_RATE_LIMITER", "BROWSER_ANON_RATE_LIMITER"),
    0
  );

  const signedIn = bindingsEnv();
  await enforceEdgeRateLimit(
    browserRequest("/api/search/stocks", {
      cookie: "__Secure-next-auth.session-token=jwt",
      "cf-connecting-ip": "198.51.100.7",
    }),
    signedIn.env,
    "/api/search/stocks",
    "shorted.com.au"
  );
  assert.equal(signedIn.limiters.BROWSER_AUTH_BURST_RATE_LIMITER.calls.length, 1);
  assert.equal(signedIn.limiters.BROWSER_AUTH_RATE_LIMITER.calls.length, 1);
  assert.equal(
    callsExcept(signedIn.limiters, "BROWSER_AUTH_BURST_RATE_LIMITER", "BROWSER_AUTH_RATE_LIMITER"),
    0
  );
});

test("an HTML navigation on the browser surface consumes nothing, even when exhausted", async () => {
  const { env, limiters } = bindingsEnv({ allow: false });
  assert.equal(
    await enforceEdgeRateLimit(browserRequest("/shorts/BHP"), env, "/shorts/BHP", "shorted.com.au"),
    null
  );
  assert.equal(callsExcept(limiters), 0);
});

test("a full /shorts/BHP page load stays well inside the anonymous browser burst bucket", async () => {
  // 9 limitable requests measured on prod; the burst bucket is 100/10s.
  const limits = resolveBucketLimits("browser-anon", {});
  assert.ok(9 * 4 < limits.burstLimit, "four stock pages in 10s must not reach the burst ceiling");
});

// ---------------------------------------------------------------------------
// 429 shape
// ---------------------------------------------------------------------------

test("an exhausted bucket returns 429 with the app layer's header contract", async () => {
  const { env } = bindingsEnv({ allow: false });
  const response = await enforceEdgeRateLimit(apiRequest("/x"), env, "/x");

  assert.ok(response, "an exhausted bucket must reject");
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("X-RateLimit-Remaining"), "0");
  assert.equal(response.headers.get("X-RateLimit-Bucket"), "api-anon");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("X-Shorted-Cache"), "RATELIMITED");
  assert.equal(response.headers.get("X-Shorted-Edge"), "cloudflare");

  const reset = parseInt(response.headers.get("X-RateLimit-Reset"), 10);
  const now = Math.floor(Date.now() / 1000);
  assert.ok(reset > now && reset <= now + 11, `reset ${reset} should be ~10s ahead of ${now}`);
});

test("RPC paths get a Connect-shaped error envelope, other paths get the zone-rule shape", async () => {
  const rpc = await buildRateLimitResponse(RPC_PATH, 600, 60, "api-key").json();
  assert.equal(rpc.code, "resource_exhausted");
  assert.match(rpc.message, /600 requests per 60 seconds/);

  const plain = await buildRateLimitResponse("/edge/v1/top-shorts", 10, 10, "api-anon").json();
  assert.equal(plain.error, "Too Many Requests");
  assert.match(plain.message, /10 requests per 10 seconds/);
});

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------

test("an absent enable flag means DISABLED — enforcement is opt-in", async () => {
  const { env, limiters } = bindingsEnv({ allow: false });
  delete env.EDGE_RATE_LIMIT_ENABLED;
  assert.equal(await enforceEdgeRateLimit(apiRequest("/x"), env, "/x"), null);
  assert.equal(callsExcept(limiters), 0);
});

test("EDGE_RATE_LIMIT_ENABLED=false is an instant kill switch on both surfaces", async () => {
  const { env, limiters } = bindingsEnv({ allow: false });
  env.EDGE_RATE_LIMIT_ENABLED = "false";

  assert.equal(await enforceEdgeRateLimit(apiRequest("/x"), env, "/x"), null);
  assert.equal(
    await enforceEdgeRateLimit(
      browserRequest("/api/search/stocks"),
      env,
      "/api/search/stocks",
      "shorted.com.au"
    ),
    null
  );
  assert.equal(callsExcept(limiters), 0);
});

// ---------------------------------------------------------------------------
// Fail-open behaviour — rate limiting must never be the reason the site is down
// ---------------------------------------------------------------------------

test("a missing binding fails open", async () => {
  assert.equal(await enforceEdgeRateLimit(apiRequest("/x"), { EDGE_RATE_LIMIT_ENABLED: "true" }, "/x"), null);
});

test("a present burst binding with a missing sustained binding still fails open", async () => {
  const env = {
    EDGE_RATE_LIMIT_ENABLED: "true",
    ANON_BURST_RATE_LIMITER: mockLimiter({ allow: true }),
  };
  assert.equal(await enforceEdgeRateLimit(apiRequest("/x"), env, "/x"), null);
});

test("a binding that throws fails open", async () => {
  const env = {
    EDGE_RATE_LIMIT_ENABLED: "true",
    ANON_BURST_RATE_LIMITER: {
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
    ANON_BURST_RATE_LIMITER: { async limit() {} },
    ANON_RATE_LIMITER: { async limit() {} },
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
    const { env } = bindingsEnv({
      allow: false,
      SHORTS_API_ORIGIN: "https://shorts-origin.test",
      EDGE_ANALYTICS_SAMPLE_RATE: "0",
    });

    const response = await worker.fetch(
      apiRequest(RPC_PATH, { "cf-connecting-ip": "1.2.3.4" }),
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

test("worker.fetch limits an API-ish browser request BEFORE the Vercel round trip", async () => {
  const originalFetch = globalThis.fetch;
  let originCalls = 0;
  globalThis.fetch = async () => {
    originCalls++;
    return new Response("<html></html>", { status: 200 });
  };

  try {
    const { env } = bindingsEnv({ allow: false, EDGE_ANALYTICS_SAMPLE_RATE: "0" });
    const response = await worker.fetch(
      browserRequest("/api/search/stocks", { "cf-connecting-ip": "1.2.3.4" }),
      env,
      { waitUntil() {} }
    );

    assert.equal(response.status, 429);
    assert.equal(originCalls, 0, "a limited browser request must not cost a Vercel invocation");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker.fetch never limits an HTML page on the browser surface", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("<html></html>", { status: 200 });

  try {
    const { env, limiters } = bindingsEnv({ allow: false, EDGE_ANALYTICS_SAMPLE_RATE: "0" });
    const response = await worker.fetch(
      browserRequest("/top", { "cf-connecting-ip": "1.2.3.4" }),
      env,
      { waitUntil() {} }
    );

    assert.equal(response.status, 200);
    assert.equal(callsExcept(limiters), 0);
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
    const { env, limiters } = bindingsEnv({
      allow: true,
      SHORTS_API_ORIGIN: "https://shorts-origin.test",
      EDGE_ANALYTICS_SAMPLE_RATE: "0",
    });

    const response = await worker.fetch(
      apiRequest(RPC_PATH, { authorization: "Bearer tok" }),
      env,
      { waitUntil() {} }
    );

    assert.equal(response.status, 200);
    assert.equal(originCalls, 0);
    assert.equal(limiters.API_KEY_BURST_RATE_LIMITER.calls.length, 1);
    assert.equal(limiters.API_KEY_RATE_LIMITER.calls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.caches = originalCaches;
  }
});
