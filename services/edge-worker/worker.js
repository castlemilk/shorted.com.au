/**
 * Shorted Edge Cache Worker
 *
 * Handles both api.shorted.com.au (API) and shorted.com.au (frontend).
 *
 * API routing (api.shorted.com.au):
 *   Multi-tier caching proxy — hot-memory -> CF Cache API -> KV -> origin
 *   Origins: SHORTS_API_ORIGIN, CHAT_SERVICE_ORIGIN, MARKET_DATA_ORIGIN
 *
 * Frontend routing (shorted.com.au):
 *   Transparent proxy to Vercel with CF-Connecting-IP forwarded so
 *   Upstash rate limiting in Vercel middleware gets the real client IP.
 *   Cloudflare's DDoS + WAF protect all frontend traffic at the proxy layer.
 *
 * Cache TTLs (from env, seconds):
 *   top_shorts  (GetTopShorts, GetShortsTreeMap, GetWeeklyReport, GetAvailableDates) -> 300 (5min)
 *   stock_data  (GetStock*, GetTimeSeries*, GetSearch, GetWatchlist, etc.)           -> 180 (3min)
 *   news        (GetNews*, GetAnnouncement*, GetMarketNews*)                          -> 300 (5min)
 *   default                                                   -> 60
 *
 * Pass-through (never cached):
 *   /health, /healthz                              - health checks -> Shorts API
 *   gRPC/Connect streaming headers                    - pass-through to Shorts API
 *   /chat.v1.*                                     - streaming -> Chat Service
 *   /register.v1.*                                 - auth -> Shorts API
 *   /api/cache/purge                               - cache purge (requires secret)
 *   All shorted.com.au (frontend) traffic           - pass-through to Vercel
 *   Unknown paths                                  - pass-through to Shorts API
 */

// ---------------------------------------------------------------------------
// In-memory hot cache — zero latency for the most popular requests
// Persists for the lifetime of this worker instance (~stateless per request,
// but hot data stays hot across requests to the same worker).
// ---------------------------------------------------------------------------

/** @type {Map<string, {body: ArrayBuffer, timestamp: number, ttl: number, contentType: string}>} */
const hotCache = new Map();

const HOT_CACHE_TTL_MS = 120_000; // 120 seconds — doubled from 60s for better hit rate
const CACHE_VERSION_KEY = "control:cache-version";
const DEFAULT_CACHE_VERSION = "v1";
const CACHE_VERSION_MEMO_MS = 5_000;

let cacheVersionMemo = {
  value: null,
  expiresAt: 0,
};

/**
 * Check if a request hits the in-memory hot cache.
 * @param {Request} request
 * @param {string} cacheKeySuffix - endpoint-specific suffix for the cache key
 * @returns {{body: ArrayBuffer, contentType: string} | null}
 */
function getHot(request, cacheKeySuffix) {
  const entry = hotCache.get(cacheKeySuffix);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > HOT_CACHE_TTL_MS) {
    hotCache.delete(cacheKeySuffix);
    return null;
  }
  return { body: entry.body, contentType: entry.contentType };
}

/**
 * Store a response in the in-memory hot cache.
 * @param {string} cacheKeySuffix
 * @param {ArrayBuffer} body
 * @param {string} contentType
 */
function setHot(cacheKeySuffix, body, contentType) {
  // Evict if map is getting large (shouldn't happen — only ~10-20 hot entries)
  if (hotCache.size > 50) {
    // Remove oldest entry
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [k, v] of hotCache) {
      if (v.timestamp < oldestTime) {
        oldestTime = v.timestamp;
        oldestKey = k;
      }
    }
    if (oldestKey) hotCache.delete(oldestKey);
  }
  hotCache.set(cacheKeySuffix, {
    body,
    timestamp: Date.now(),
    ttl: HOT_CACHE_TTL_MS,
    contentType,
  });
}

async function getCacheVersion(env) {
  const fallback = env.CACHE_VERSION || DEFAULT_CACHE_VERSION;
  if (!env.EDGE_KV) {
    return fallback;
  }

  const now = Date.now();
  if (cacheVersionMemo.value && cacheVersionMemo.expiresAt > now) {
    return cacheVersionMemo.value;
  }

  try {
    const version = await env.EDGE_KV.get(CACHE_VERSION_KEY);
    const activeVersion = version || fallback;
    setCacheVersionMemo(activeVersion);
    return activeVersion;
  } catch (_) {
    return fallback;
  }
}

function setCacheVersionMemo(value) {
  cacheVersionMemo = {
    value,
    expiresAt: Date.now() + CACHE_VERSION_MEMO_MS,
  };
}

function newCacheVersion() {
  const random = typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
  return `${Date.now().toString(36)}-${random}`;
}

// ---------------------------------------------------------------------------
// Worker fetch handler
// ---------------------------------------------------------------------------

const FRONTEND_ORIGIN = "https://shorted.com.au";
const FRONTEND_HOST = "shorted.com.au";
const API_HOST = "api.shorted.com.au";
const EDGE_READ_PREFIX = "/edge/v1";

// ---------------------------------------------------------------------------
// Edge rate limiting — per-minute enforcement (Cloudflare Rate Limiting API)
//
// WHY THIS LIVES HERE: the app-layer limiter (services/pkg/ratelimit) used to
// run a 7-command Upstash pipeline per request against the SAME Upstash
// database that backs the page cache. That exhausted the free-tier command
// quota; Upstash then rejected writes while still serving reads, which both
// degraded rate limiting AND froze the page cache. Per-minute limiting must
// never depend on Upstash again. It now runs at the edge, on Cloudflare's own
// rate limiting bindings, with no external dependency and no added latency.
//
// THIS LAYER IS TIER-BLIND, AND DELIBERATELY SO. The worker cannot resolve a
// caller's paid tier without a database lookup, and doing one at the edge would
// reintroduce exactly the coupling we removed. Per-TIER per-minute enforcement
// (free 60/min API, 120/min browser, ...) lives in-process in
// services/pkg/ratelimit. Everything here is a ceiling that protects the
// ORIGIN from runaway/abusive traffic, nothing more.
//
// TWO SURFACES. This one worker is routed on BOTH hostnames, and the client IP
// it sees is completely different on each:
//
//   shorted.com.au/*      browser -> Cloudflare -> Vercel.  cf-connecting-ip is
//                         the REAL end user. This is the only surface where an
//                         IP-keyed browser bucket is meaningful.
//
//   api.shorted.com.au/*  two populations. Direct API clients (real IPs), and
//                         requests the Next.js rewrites in web/next.config.mjs
//                         proxy from Vercel — those arrive from a handful of
//                         SHARED VERCEL EGRESS IPs. An anon-IP bucket there
//                         would collapse every browser onto a few keys and 429
//                         real users, which is why #455 shipped with
//                         enforcement off. First-party traffic now identifies
//                         itself with the SSR bypass header (attached by
//                         web/src/middleware.ts) and gets its own runaway
//                         bucket instead.
//
// TWO WINDOWS PER CLASS. Cloudflare's rate limiting binding `period` is a hard
// enum — 10 or 60 seconds, nothing else — so "burst" and "sustained" cannot be
// one binding. Each class gets two: a 10s burst bucket that stops a hammering
// script within a second or two, and a 60s sustained bucket that stops a slow
// grind the burst bucket would never see. Burst is checked FIRST so the 429
// carries the shorter, more accurate Retry-After.
//
// THE NUMBERS ARE MEASURED, NOT GUESSED. Playwright against prod, logged out,
// counting only limitable (non-HTML, non-/api/auth) requests per page load:
//
//     /shorts/BHP   9 requests   (GetStockData, market-data/historical,
//                                 GetStockVerdict, GetStockSignals,
//                                 GetStockGraph, ListStockPoliticians,
//                                 community summary, 2x auth/session)
//     /             6 requests
//     /top          2 requests
//
// Worst realistic human burst = 3-4 stock pages in 10s = ~27-36 requests.
// Hard browsing for a minute = 10-15 pages = ~90-135 requests. A power user
// working the screener/chart controls fires ~1 RPC per control change, so
// 15-20 RPCs in 10s is reachable. The browser buckets below sit at roughly 3x
// the measured 10s worst case and 4.4x the 60s worst case. A normal user must
// NEVER hit these while browsing; Cloudflare SBFM already challenges automated
// traffic, so these exist purely to stop egregious hammering.
//
// Cloudflare's rate limiting counters are PER-COLO and eventually consistent
// (documented behaviour), so the effective global ceiling is the configured
// limit times the number of colos a client reaches. That is fine for a ceiling
// and is another reason the precise monthly quota stays app-side.
// ---------------------------------------------------------------------------

const RATE_LIMIT_BURST_PERIOD_SECONDS = 10;
const RATE_LIMIT_SUSTAINED_PERIOD_SECONDS = 60;

/**
 * The bucket matrix. One entry per traffic class; each names its two bindings,
 * the worker vars Terraform uses to override the numbers, and the compiled-in
 * fallbacks used when a var is absent (local `node --test`, a not-yet-applied
 * deploy). Key prefixes are distinct so a token hash can never collide with an
 * IP or a session hash.
 *
 * Terraform (terraform/modules/cloudflare-edge) is the source of truth for
 * every number here; the defaults must match variables.tf.
 */
const RATE_LIMIT_BUCKETS = {
  // api host, authenticated. The documented PAID API tier is per-minute
  // UNLIMITED, so this cannot be a tier ceiling — 600/60s is a runaway/abuse
  // ceiling that still leaves a legitimate bulk pull (10 req/s sustained)
  // completely unimpeded.
  "api-key": {
    prefix: "k",
    burstBinding: "API_KEY_BURST_RATE_LIMITER",
    burstVar: "RATE_LIMIT_KEY_BURST",
    burstDefault: 100,
    sustainedBinding: "API_KEY_RATE_LIMITER",
    sustainedVar: "RATE_LIMIT_KEY_LIMIT",
    sustainedDefault: 600,
  },
  // api host, anonymous, keyed by real client IP. This is the one class where
  // the ceiling intentionally equals the documented anonymous API tier
  // (30/min) — an unauthenticated caller hitting the public API host directly
  // has no entitlement beyond it.
  "api-anon": {
    prefix: "a",
    burstBinding: "ANON_BURST_RATE_LIMITER",
    burstVar: "RATE_LIMIT_ANON_BURST",
    burstDefault: 10,
    sustainedBinding: "ANON_RATE_LIMITER",
    sustainedVar: "RATE_LIMIT_ANON_LIMIT",
    sustainedDefault: 30,
  },
  // api host, first-party (Vercel SSR/ISR and rewrite-proxied browser calls,
  // proven by the SSR bypass secret). These must NOT enter the anon-IP bucket.
  // A single burst bucket keyed by egress IP acts as a runaway detector: it is
  // sized so ordinary ISR regeneration bursts and rewrite fan-out never trip
  // it, and only a genuine loop — an ISR page regenerating itself thousands of
  // times a second — can. If this ever fires in normal traffic, raise it; it
  // is not a tier and has no entitlement meaning.
  "first-party": {
    prefix: "f",
    burstBinding: "FIRST_PARTY_RATE_LIMITER",
    burstVar: "RATE_LIMIT_FIRST_PARTY_BURST",
    burstDefault: 600,
    sustainedBinding: null,
  },
  // browser surface, anonymous, keyed by the REAL client IP.
  // 100/10s ~= 3x the measured worst human burst (27-36); 600/60s ~= 4.4x the
  // measured worst minute (90-135).
  "browser-anon": {
    prefix: "ba",
    burstBinding: "BROWSER_ANON_BURST_RATE_LIMITER",
    burstVar: "RATE_LIMIT_BROWSER_ANON_BURST",
    burstDefault: 100,
    sustainedBinding: "BROWSER_ANON_RATE_LIMITER",
    sustainedVar: "RATE_LIMIT_BROWSER_ANON_LIMIT",
    sustainedDefault: 600,
  },
  // browser surface, signed in — keyed by a hash of the next-auth session
  // cookie, NOT the IP, so an office/university/CGNAT egress cannot collapse
  // every colleague onto one bucket. Double the anonymous allowance.
  "browser-auth": {
    prefix: "bu",
    burstBinding: "BROWSER_AUTH_BURST_RATE_LIMITER",
    burstVar: "RATE_LIMIT_BROWSER_AUTH_BURST",
    burstDefault: 200,
    sustainedBinding: "BROWSER_AUTH_RATE_LIMITER",
    sustainedVar: "RATE_LIMIT_BROWSER_AUTH_LIMIT",
    sustainedDefault: 1200,
  },
};

// Paths that must never be rate limited on EITHER surface.
//
// /api/auth/* is the load-bearing one: next-auth's session endpoint fires on
// every single page load (it is 2 of the 9 requests on /shorts/BHP), so
// limiting it would break sign-in state during ordinary browsing — the exact
// failure mode this design must not have.
const RATE_LIMIT_EXEMPT_PATHS = new Set(["/health", "/healthz"]);
const RATE_LIMIT_EXEMPT_PREFIXES = ["/api/auth/", "/api/auth", "/api/health"];

// The ONLY paths limited on the browser surface (shorted.com.au). Everything
// else — every HTML document route, every static asset, every Next.js chunk —
// is untouched. Mirrors web/src/middleware.ts RATE_LIMITED_PATHS plus the
// rewrite-proxied prefixes in web/next.config.mjs, because from the browser's
// point of view those are same-origin API calls.
const BROWSER_LIMITED_PREFIXES = [
  "/api/market-data",
  "/api/search",
  "/api/community",
  "/api/stripe/checkout",
  "/api/stripe/portal",
  "/api/stocks", // rewrite -> shorts API
  "/api/algolia", // rewrite -> shorts API
  "/edge/v1/", // rewrite -> api.shorted.com.au edge reads
  "/chat.v1.ChatService",
  "/register.v1.RegisterService", // rewrite -> shorts API
];

// The shorts.v1alpha1 domain services are rewrite-proxied by a regex in
// next.config.mjs (one rule covers every *Service), so match the same shape
// here rather than hand-maintaining a service list.
const BROWSER_LIMITED_PATTERNS = [/^\/shorts\.v1alpha1\.[A-Za-z]+Service\//];

// next-auth session cookie names. Production uses the __Secure- prefix; local
// dev does not. next-auth also CHUNKS a large session cookie into `.0`, `.1`,
// ... so the chunked spelling has to be recognised or a signed-in user with a
// large JWT would silently fall into the anonymous bucket.
const SESSION_COOKIE_NAMES = [
  "__Secure-next-auth.session-token",
  "next-auth.session-token",
];

// User agents treated as search crawlers when Bot Management is not available
// to verify them. See resolveVerifiedBot() for why this list exists and what
// it deliberately trades away.
const SEARCH_CRAWLER_UA_PATTERN =
  /(googlebot|google-inspectiontool|bingbot|slurp|duckduckbot|baiduspider|yandex(bot|images)|applebot|petalbot|gptbot|oai-searchbot|chatgpt-user|perplexitybot|claudebot|anthropic-ai)/i;

const worker = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const hostname = url.hostname;
    const started = Date.now();

    const defaults = {
      cacheTtlDefault: parseInt(env.CACHE_TTL_DEFAULT || "60", 10),
      cacheTtlTopShorts: parseInt(env.CACHE_TTL_TOP_SHORTS || "300", 10),
      cacheTtlStockData: parseInt(env.CACHE_TTL_STOCK_DATA || "120", 10),
      cacheTtlNews: parseInt(env.CACHE_TTL_NEWS || "300", 10),
      cacheTtlPublicDaily: parseInt(env.CACHE_TTL_PUBLIC_DAILY || "3600", 10),
      cacheTtlPublicStale: parseInt(env.CACHE_TTL_PUBLIC_STALE || "86400", 10),
    };

    const shortsApiOrigin = env.SHORTS_API_ORIGIN;
    const marketDataOrigin = env.MARKET_DATA_ORIGIN;

    // --- 0. FRONTEND: shorted.com.au -> proxy to Vercel
    // Forward CF-Connecting-IP so Vercel-side code still sees the real client IP.
    // Cloudflare DDoS + WAF protect this traffic at the proxy layer.
    //
    // This is the ONLY surface that sees the real end-user IP, so the browser
    // buckets are enforced here — before the Vercel round trip, so a limited
    // request costs no origin work at all. Only API-ish paths are eligible
    // (see BROWSER_LIMITED_PREFIXES); HTML documents are never limited.
    if (hostname === FRONTEND_HOST || hostname === `www.${FRONTEND_HOST}`) {
      const browserLimited = await enforceEdgeRateLimit(request, env, path, hostname);
      if (browserLimited) {
        return withEdgeAnalytics(request, env, browserLimited, "edge-ratelimit", 0, started);
      }
      return withEdgeAnalytics(request, env, proxyFrontend(request, env, FRONTEND_ORIGIN), "frontend", 0, started);
    }

    // --- 0.25. EDGE RATE LIMIT: origin-protection ceilings for the API host.
    // Runs before any cache lookup or origin fetch so a limited request costs
    // nothing downstream.
    const limited = await enforceEdgeRateLimit(request, env, path, hostname);
    if (limited) {
      return withEdgeAnalytics(request, env, limited, "edge-ratelimit", 0, started);
    }

    // --- 0.4. Connect RPC paths are POST-only. Answer a GET/HEAD here rather
    // than forwarding it, because the origin handler simply never responds to
    // a body-less GET and Cloudflare eventually records a 504 with
    // originResponseStatus=0 — an origin request that was always going to fail.
    //
    // The only known source of these was our own SWR revalidation of a
    // synthesized GET cache key (see edgeCacheControl), now fixed. This guard
    // is the belt-and-braces: those synthesized `?_cv=&_bh=` URLs are real,
    // fetchable URLs, so a crawler or a replayed log line can produce the same
    // hang. 405 is cheap, correct, and never reaches origin.
    //
    // Note this is NOT the public GET facade — that lives under
    // EDGE_READ_PREFIX below and builds its own POST upstream.
    if (
      (request.method === "GET" || request.method === "HEAD") &&
      isConnectRpcPath(path)
    ) {
      const resp = new Response(
        JSON.stringify({
          code: "unimplemented",
          message: "Connect RPC endpoints accept POST only.",
        }),
        { status: 405, headers: { "Content-Type": "application/json", Allow: "POST", "Cache-Control": "no-store" } }
      );
      return withEdgeAnalytics(request, env, resp, "rpc-method-guard", 0, started);
    }

    // --- 0.5. PUBLIC EDGE READS: GET facade over public Connect RPC reads
    // The frontend can call these as normal GETs while the worker reuses the
    // same POST RPC cache keys that prewarm.js populates in KV.
    if (hostname === API_HOST && path.startsWith(EDGE_READ_PREFIX)) {
      return withEdgeAnalytics(
        request,
        env,
        handlePublicEdgeRead(request, url, env, ctx, defaults, shortsApiOrigin, marketDataOrigin),
        "edge-read",
        defaults.cacheTtlPublicDaily,
        started
      );
    }

    // --- 1. BYPASS: never cache these ---

    // Health checks -> Shorts API
    if (path === "/health" || path === "/healthz") {
      return withEdgeAnalytics(request, env, proxyWithHeaders(request, shortsApiOrigin, "BYPASS"), "shorts", 0, started);
    }

    // gRPC/Connect streaming indicators -> pass-through to the Shorts API.
    // IMPORTANT: chat and market-data Connect requests ALSO carry these headers,
    // so they must be excluded here and fall through to their own path-based
    // routes below — otherwise every browser Connect call (which always sends
    // `connect-protocol-version`) gets misrouted to the Shorts origin and 404s.
    if (
      (request.headers.get("connect-protocol-version") ||
        request.headers.get("grpc-timeout") ||
        request.headers.get("x-grpc-web")) &&
      !path.includes("/chat.v1.") &&
      !path.includes("/marketdata.v1.")
    ) {
      return withEdgeAnalytics(request, env, proxyWithHeaders(request, shortsApiOrigin, "BYPASS"), "shorts", 0, started);
    }

    // Cache purge endpoint (requires shared secret)
    if (path === "/api/cache/purge" && request.method === "POST") {
      const purgeBody = await request.text();
      if (!env.CACHE_PURGE_SECRET || purgeBody !== env.CACHE_PURGE_SECRET) {
        return withEdgeAnalytics(request, env, new Response("Unauthorized", { status: 401 }), "edge-control", 0, started);
      }
      return withEdgeAnalytics(request, env, handlePurge(env), "edge-control", 0, started);
    }

    // Chat service is intentionally not exposed through the public API host.
    // Browser chat must go through the same-origin Next.js guarded route so
    // auth, paid entitlement, CSRF, and per-user quota checks run first.
    if (path.includes("/chat.v1.")) {
      const response = new Response("Not found", { status: 404 });
      stampEdgeHeaders(response, "BYPASS");
      return withEdgeAnalytics(request, env, response, "chat", 0, started);
    }

    // Auth/register -> Shorts API (never cache)
    if (path.includes("/register.v1.")) {
      return withEdgeAnalytics(request, env, proxyWithHeaders(request, shortsApiOrigin, "BYPASS"), "shorts", 0, started);
    }

    // --- 2. MARKET DATA -> cache with stock_data TTL ---
    // Proto package is `marketdata.v1` (no underscore). Previous matcher
    // `/market_data.v1.` never fired because the proto path uses no
    // underscore; the frontend bypassed the worker by hitting market-data
    // directly. After Cloudflare became the only origin path, this needed
    // to align with the actual gRPC path.
    if (path.includes("/marketdata.v1.")) {
      return withEdgeAnalytics(
        request,
        env,
        handleCachedRequest(request, url, env, ctx, marketDataOrigin, defaults.cacheTtlStockData),
        "market-data",
        defaults.cacheTtlStockData,
        started
      );
    }

    // --- 3. SHORTS API -> endpoint-aware caching with hot path ---
    if (path.includes("/shorts.v1alpha1.")) {
      const ttl = resolveShortsTtl(path, defaults);
      const cacheVersion = await getCacheVersion(env);
      let hotKey = null;

      // Try hot cache first (only for GET-equivalent read-only requests)
      if (request.method === "POST") {
        hotKey = await buildHotCacheKey(request, path, cacheVersion);
        const hot = getHot(request, hotKey);
        if (hot) {
          const resp = new Response(hot.body, {
            status: 200,
            headers: { "Content-Type": hot.contentType },
          });
          stampEdgeHeaders(resp, "HOT");
          return withEdgeAnalytics(request, env, resp, "shorts", ttl, started);
        }
      }

      const result = await handleCachedRequest(request, url, env, ctx, shortsApiOrigin, ttl, cacheVersion);

      // After a successful origin fetch, populate hot cache for top shorts + stocks
      // Only for read-only requests that were cache misses
      if (result.headers.get("X-Shorted-Cache") === "MISS" && request.method === "POST" && hotKey) {
        try {
          // Clone response body before it's consumed
          const body = await result.clone().arrayBuffer();
          const ct = result.headers.get("Content-Type") || "application/json";
          setHot(hotKey, body, ct);
        } catch (_) {
          // Non-fatal — hot cache population is best-effort
        }
      }

      return withEdgeAnalytics(request, env, result, "shorts", ttl, started);
    }

    // --- 4. UNKNOWN -> pass-through to Shorts API ---
    return withEdgeAnalytics(request, env, proxyWithHeaders(request, shortsApiOrigin, "BYPASS"), "shorts", 0, started);
  },
};

export default worker;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Edge rate limiting helpers
// ---------------------------------------------------------------------------

/**
 * Extract the caller's API credential, if any.
 *
 * Recognises the three shapes the API accepts: `Authorization: Bearer <token>`,
 * a bare `Authorization: <token>`, and `X-API-Key: <token>`.
 *
 * @param {Request} request
 * @returns {string} the raw token, or "" when the request is unauthenticated
 */
export function extractRateLimitToken(request) {
  const apiKey = request.headers.get("x-api-key");
  if (apiKey && apiKey.trim()) return apiKey.trim();

  const auth = request.headers.get("authorization");
  if (!auth) return "";

  const trimmed = auth.trim();
  if (!trimmed) return "";

  const match = /^bearer\s+(.+)$/i.exec(trimmed);
  if (match) return match[1].trim();

  return trimmed;
}

/**
 * Constant-ish-time string comparison for shared secrets. JS cannot guarantee
 * constant time, but comparing every byte removes the trivial early-exit
 * timing signal that `===` on strings can expose.
 *
 * @param {string} a
 * @param {string} b
 */
function secretsMatch(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length === 0 || b.length === 0) return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Mirror of the zone-level skip rules in terraform/modules/cloudflare-edge.
 *
 * Two traffic classes carry a first-party marker:
 *
 *   1. "testing" — trusted E2E/load tests. UA marker + x-shorted-testing-bypass
 *      secret. Skips edge limiting entirely, exactly as it skips the zone rule.
 *   2. "ssr" — first-party Vercel traffic. UA marker + x-shorted-ssr-bypass
 *      secret. Attached by web/src/app/actions/config.ts for server actions and
 *      by web/src/middleware.ts for rewrite-proxied RPCs. This one does NOT
 *      skip outright: it routes the request into the `first-party` runaway
 *      bucket instead of the anon-IP bucket, which is precisely what makes
 *      enforcement safe to enable (shared Vercel egress IPs would otherwise
 *      collapse every browser onto a handful of anon keys).
 *
 * As in Terraform, BOTH the user-agent marker AND the exact secret are
 * required — never the UA alone, which anyone can spoof. An unset secret
 * disables that class entirely (it can never match).
 *
 * @param {Request} request
 * @param {Record<string, string>} env
 * @returns {"" | "testing" | "ssr"} the matched bypass class, or ""
 */
export function resolveRateLimitBypass(request, env) {
  const ua = request.headers.get("user-agent") || "";

  const testingSecret = env.RATE_LIMIT_TESTING_BYPASS_SECRET || "";
  const testingUa = env.RATE_LIMIT_TESTING_BYPASS_USER_AGENT || "Shorted-E2E";
  const testingHeader = env.RATE_LIMIT_TESTING_BYPASS_HEADER_NAME || "x-shorted-testing-bypass";
  if (
    testingSecret &&
    ua.includes(testingUa) &&
    secretsMatch(request.headers.get(testingHeader) || "", testingSecret)
  ) {
    return "testing";
  }

  const ssrSecret = env.RATE_LIMIT_SSR_BYPASS_SECRET || "";
  const ssrUa = env.RATE_LIMIT_SSR_BYPASS_USER_AGENT || "shorted-web-ssr";
  const ssrHeader = env.RATE_LIMIT_SSR_BYPASS_HEADER_NAME || "x-shorted-ssr-bypass";
  if (
    ssrSecret &&
    ua.includes(ssrUa) &&
    secretsMatch(request.headers.get(ssrHeader) || "", ssrSecret)
  ) {
    return "ssr";
  }

  return "";
}

/**
 * Which surface is this request on?
 *
 * The distinction is load-bearing: the same worker script runs on two routes
 * (`api.shorted.com.au/*` in Terraform, `shorted.com.au/*` managed outside it)
 * and only the browser surface sees a real end-user IP.
 *
 * @param {string} hostname
 * @returns {"browser" | "api"}
 */
export function resolveRateLimitSurface(hostname) {
  return hostname === FRONTEND_HOST || hostname === `www.${FRONTEND_HOST}` ? "browser" : "api";
}

/**
 * Is this path eligible for rate limiting at all?
 *
 * On the API host everything is eligible except the explicit exemptions — the
 * host serves nothing but API traffic. On the browser host ONLY the API-ish
 * paths are eligible; HTML document routes, static assets and Next.js chunks
 * must never be limited (limiting a document route would blank the site for a
 * real reader, and would also risk throttling a crawler mid-crawl).
 *
 * @param {"browser" | "api"} surface
 * @param {string} path
 */
export function isRateLimitEligiblePath(surface, path) {
  if (RATE_LIMIT_EXEMPT_PATHS.has(path)) return false;
  if (RATE_LIMIT_EXEMPT_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix))) {
    return false;
  }
  if (surface === "api") return true;

  return (
    BROWSER_LIMITED_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix)) ||
    BROWSER_LIMITED_PATTERNS.some((pattern) => pattern.test(path))
  );
}

/**
 * Extract the next-auth session cookie value, if the browser is signed in.
 *
 * Handles the `__Secure-` production spelling, the plain dev spelling, and
 * next-auth's CHUNKED form (`<name>.0`, `<name>.1`, ...) which appears once the
 * session JWT outgrows a single cookie. Chunks are concatenated in index order
 * so the same session always produces the same key.
 *
 * @param {Request} request
 * @returns {string} the session value, or "" when anonymous
 */
export function extractSessionCookie(request) {
  const header = request.headers.get("cookie");
  if (!header) return "";

  /** @type {Map<string, string>} */
  const jar = new Map();
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    jar.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }

  for (const name of SESSION_COOKIE_NAMES) {
    const whole = jar.get(name);
    if (whole) return whole;

    const chunks = [];
    for (let i = 0; ; i++) {
      const chunk = jar.get(`${name}.${i}`);
      if (chunk === undefined) break;
      chunks.push(chunk);
    }
    if (chunks.length) return chunks.join("");
  }

  return "";
}

/**
 * The client IP as Cloudflare sees it.
 *
 * `cf-connecting-ip` is set by Cloudflare itself and cannot be spoofed by the
 * client. The fallbacks only matter off-platform (tests, local dev); for
 * `x-forwarded-for` we take the RIGHTMOST entry — the one the nearest trusted
 * proxy appended — because the leftmost is attacker-controlled.
 *
 * @param {Request} request
 */
function clientIp(request) {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-real-ip") ||
    (request.headers.get("x-forwarded-for") || "").split(",").pop()?.trim() ||
    "unknown"
  );
}

/**
 * Is this a verified search crawler that must never be rate limited?
 *
 * SEO is the product. A 429 to Googlebot is not a throttle, it is a crawl-rate
 * penalty that suppresses indexation for days, so crawlers skip every bucket.
 *
 * `request.cf.botManagement.verifiedBot` is the authoritative signal, but the
 * `botManagement` object is only populated when Cloudflare Bot Management is
 * active on the zone. When it is absent we CANNOT verify, and we deliberately
 * choose the SEO-safe error: a request whose user-agent claims to be a search
 * crawler is skipped. That is spoofable — but the thing it buys an attacker is
 * only exemption from an origin-protection ceiling, while the zone's WAF, SBFM
 * (`sbfm_verified_bots = "allow"`, see terraform/modules/cloudflare-edge) and
 * DDoS layers still apply. Losing indexation is the worse failure.
 *
 * Set `EDGE_RATE_LIMIT_TRUST_CRAWLER_UA=false` to require real verification.
 *
 * @param {Request} request
 * @param {Record<string, any>} env
 */
export function isVerifiedCrawler(request, env = {}) {
  const bot = request.cf && request.cf.botManagement;
  if (bot && typeof bot.verifiedBot === "boolean") {
    return bot.verifiedBot === true;
  }

  if (env.EDGE_RATE_LIMIT_TRUST_CRAWLER_UA === "false") return false;
  return SEARCH_CRAWLER_UA_PATTERN.test(request.headers.get("user-agent") || "");
}

/**
 * Decide which bucket class a request belongs to, and build its key.
 *
 * Precedence, and why:
 *   1. browser surface -> session cookie present ? browser-auth : browser-anon.
 *      An API token on the browser surface is not a thing we serve, so the
 *      cookie is the only identity that matters there.
 *   2. api surface -> a proven first-party caller (SSR/ISR or a Vercel rewrite
 *      carrying the SSR bypass secret) gets `first-party`. This MUST come
 *      before the anon check: those requests all share a few Vercel egress IPs
 *      and would otherwise collapse into one anon bucket and 429 real users.
 *   3. api surface -> credential present ? api-key : api-anon.
 *
 * Keys are namespaced per class, so a token hash can never collide with an IP
 * or a session hash. Tokens and session cookies are HASHED (SHA-256, truncated
 * to 32 hex chars = 128 bits of key space) — a raw credential must never become
 * part of rate limit state.
 *
 * @param {Request} request
 * @param {Record<string, any>} env
 * @param {"browser" | "api"} surface
 * @param {"" | "testing" | "ssr"} bypass the already-resolved bypass class
 * @returns {Promise<{bucketClass: string, key: string}>}
 */
export async function resolveEdgeRateLimitKey(request, env = {}, surface = "api", bypass = "") {
  if (surface === "browser") {
    const session = extractSessionCookie(request);
    if (session) {
      const digest = await hashString(session);
      return { bucketClass: "browser-auth", key: `bu:${digest.slice(0, 32)}` };
    }
    return { bucketClass: "browser-anon", key: `ba:${clientIp(request)}` };
  }

  if (bypass === "ssr") {
    // Keyed by egress IP: one runaway Vercel instance is contained without
    // penalising the others.
    return { bucketClass: "first-party", key: `f:${clientIp(request)}` };
  }

  const token = extractRateLimitToken(request);
  if (token) {
    const digest = await hashString(token);
    return { bucketClass: "api-key", key: `k:${digest.slice(0, 32)}` };
  }

  return { bucketClass: "api-anon", key: `a:${clientIp(request)}` };
}

/**
 * Resolve the configured limits for a bucket class. Terraform sets the worker
 * vars; the compiled-in defaults only apply when a var is missing.
 *
 * @param {string} bucketClass
 * @param {Record<string, any>} env
 */
export function resolveBucketLimits(bucketClass, env = {}) {
  const spec = RATE_LIMIT_BUCKETS[bucketClass];
  if (!spec) return null;

  const burstLimit = positiveInt(parseInt(env[spec.burstVar] || "", 10), spec.burstDefault);
  const sustainedLimit = spec.sustainedBinding
    ? positiveInt(parseInt(env[spec.sustainedVar] || "", 10), spec.sustainedDefault)
    : 0;

  return { spec, burstLimit, sustainedLimit };
}

/**
 * Build the 429 returned when an edge bucket is exhausted.
 *
 * Mirrors the app layer's header contract (services/pkg/ratelimit): the same
 * X-RateLimit-* names and a Retry-After. The Cloudflare Rate Limiting API
 * returns only `{ success }` — no remaining/reset info — so Reset is
 * synthesized from the window that actually tripped, which is the tightest
 * honest bound (and why burst is checked first: a burst 429 tells the caller to
 * come back in 10s, not 60).
 *
 * @param {string} path
 * @param {number} limit
 * @param {number} periodSeconds
 * @param {string} bucketClass
 */
export function buildRateLimitResponse(path, limit, periodSeconds, bucketClass = "") {
  const resetAt = Math.floor(Date.now() / 1000) + periodSeconds;
  const message = `rate limit exceeded: ${limit} requests per ${periodSeconds} seconds`;

  // Connect-RPC clients parse a JSON error envelope; everything else gets the
  // same shape the zone-level rate limit rule returns.
  const isRpc = /\/[a-z0-9_.]+\.v1(alpha1)?\.[A-Za-z]+\//.test(path);
  const body = isRpc
    ? JSON.stringify({ code: "resource_exhausted", message })
    : JSON.stringify({ error: "Too Many Requests", message });

  const response = new Response(body, {
    status: 429,
    headers: {
      "Content-Type": "application/json",
      "Retry-After": String(periodSeconds),
      "X-RateLimit-Limit": String(limit),
      "X-RateLimit-Remaining": "0",
      "X-RateLimit-Reset": String(resetAt),
      "X-RateLimit-Scope": `edge-${periodSeconds}s`,
      "X-RateLimit-Bucket": bucketClass,
      "Cache-Control": "no-store",
    },
  });
  stampEdgeHeaders(response, "RATELIMITED");
  return response;
}

/**
 * Enforce the edge rate limit buckets.
 *
 * Returns a 429 Response when the request should be rejected, or null when it
 * should continue. Fails OPEN in every ambiguous case — a missing binding, a
 * throwing binding, an unknown class, an ineligible path — all return null.
 * Rate limiting must never be the reason the site or API goes down.
 *
 * @param {Request} request
 * @param {Record<string, any>} env
 * @param {string} path
 * @param {string} hostname
 * @returns {Promise<Response | null>}
 */
export async function enforceEdgeRateLimit(request, env, path, hostname = API_HOST) {
  // Opt-IN, not opt-out: enforcement requires an explicit "true".
  if (env.EDGE_RATE_LIMIT_ENABLED !== "true") return null;

  const surface = resolveRateLimitSurface(hostname);
  if (!isRateLimitEligiblePath(surface, path)) return null;

  // A verified search crawler is never limited, on either surface. SEO is the
  // product; a 429 to Googlebot suppresses indexation for days.
  if (isVerifiedCrawler(request, env)) return null;

  // Trusted E2E/load tests skip everything, exactly as they skip the zone rule.
  // First-party SSR does NOT skip outright any more — it gets its own runaway
  // bucket (see resolveEdgeRateLimitKey), which is what makes it safe to turn
  // enforcement on at all.
  const bypass = resolveRateLimitBypass(request, env);
  if (bypass === "testing") return null;

  try {
    const { bucketClass, key } = await resolveEdgeRateLimitKey(request, env, surface, bypass);
    const limits = resolveBucketLimits(bucketClass, env);
    if (!limits) return null;

    const { spec, burstLimit, sustainedLimit } = limits;

    // Burst (10s) first: it catches a hammering client within a second or two,
    // and its 429 carries the shorter, more accurate Retry-After.
    const burst = env[spec.burstBinding];
    if (burst && typeof burst.limit === "function") {
      const outcome = await burst.limit({ key });
      if (outcome && outcome.success === false) {
        return buildRateLimitResponse(path, burstLimit, RATE_LIMIT_BURST_PERIOD_SECONDS, bucketClass);
      }
    }

    // Sustained (60s): catches the slow grind that never trips a 10s window.
    // Some classes (first-party) have no sustained bucket by design.
    if (!spec.sustainedBinding) return null;
    const sustained = env[spec.sustainedBinding];
    if (sustained && typeof sustained.limit === "function") {
      const outcome = await sustained.limit({ key });
      if (outcome && outcome.success === false) {
        return buildRateLimitResponse(
          path,
          sustainedLimit,
          RATE_LIMIT_SUSTAINED_PERIOD_SECONDS,
          bucketClass
        );
      }
    }
  } catch (err) {
    // Never let a limiter fault take down the API.
    try {
      console.log(JSON.stringify({ type: "edge_ratelimit_error", message: String(err) }));
    } catch (_) {
      // Logging is best-effort.
    }
  }

  return null;
}

async function handlePublicEdgeRead(request, url, env, ctx, defaults, shortsApiOrigin, marketDataOrigin) {
  if (request.method !== "GET") {
    const response = new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET" },
    });
    stampEdgeHeaders(response, "BYPASS");
    response.headers.set("Cache-Control", "no-store");
    return response;
  }

  const route = resolvePublicEdgeReadRoute(url);
  if (!route) {
    const response = new Response("Not found", { status: 404 });
    stampEdgeHeaders(response, "BYPASS");
    response.headers.set("Cache-Control", "no-store");
    return response;
  }

  const origin = route.origin === "market" ? marketDataOrigin : shortsApiOrigin;
  if (!origin) {
    const response = new Response("Origin not configured", { status: 503 });
    stampEdgeHeaders(response, "BYPASS");
    response.headers.set("Cache-Control", "no-store");
    return response;
  }

  const rpcUrl = new URL(url.toString());
  rpcUrl.pathname = route.path;
  rpcUrl.search = "";
  rpcUrl.hash = "";
  const rpcRequest = new Request(rpcUrl.toString(), {
    method: "POST",
    headers: buildPublicEdgeReadHeaders(request),
    body: JSON.stringify(route.body),
  });

  const ttl = positiveInt(defaults.cacheTtlPublicDaily, 3600);
  const staleTtl = positiveInt(defaults.cacheTtlPublicStale, 86400);
  const cacheVersion = await getCacheVersion(env);
  const hotKey = await buildHotCacheKey(rpcRequest, route.path, cacheVersion);
  const hot = getHot(rpcRequest, hotKey);
  if (hot) {
    const response = new Response(hot.body, {
      status: 200,
      headers: { "Content-Type": hot.contentType },
    });
    stampEdgeHeaders(response, "HOT");
    promotePublicEdgeReadResponse(response, ttl, staleTtl);
    return response;
  }

  const response = await handleCachedRequest(rpcRequest, rpcUrl, env, ctx, origin, ttl, cacheVersion);
  const cacheStatus = response.headers.get("X-Shorted-Cache");
  if (response.ok && ["MISS", "HIT", "KV"].includes(cacheStatus || "")) {
    try {
      const body = await response.clone().arrayBuffer();
      const contentType = response.headers.get("Content-Type") || "application/json";
      setHot(hotKey, body, contentType);
    } catch (_) {
      // Non-fatal — hot cache population is best-effort.
    }
  }
  promotePublicEdgeReadResponse(response, ttl, staleTtl);
  return response;
}

function buildPublicEdgeReadHeaders(request) {
  const headers = new Headers();
  headers.set("Accept", "application/json");
  headers.set("Content-Type", "application/json");
  const userAgent = request.headers.get("user-agent");
  headers.set("User-Agent", userAgent || "Shorted-Edge-Read/1.0");
  return headers;
}

function promotePublicEdgeReadResponse(response, ttl, staleTtl) {
  if (response.ok) {
    response.headers.delete("Set-Cookie");
    response.headers.set(
      "Cache-Control",
      `public, max-age=${ttl}, s-maxage=${ttl}, stale-while-revalidate=${staleTtl}`
    );
  } else {
    response.headers.set("Cache-Control", "no-store");
  }
  response.headers.set("X-Shorted-Fast-Path", "edge-read");
  if (!response.headers.has("X-Shorted-Cache")) {
    stampEdgeHeaders(response, response.ok ? "MISS" : "BYPASS");
  }
}

export function resolvePublicEdgeReadRoute(url) {
  const path = url.pathname;
  const params = url.searchParams;

  if (path === `${EDGE_READ_PREFIX}/top-shorts`) {
    const body = {
      period: edgePeriod(params, "period", "3m"),
      // Backend validation allows limit <= 1000; a lower edge clamp silently
      // dropped constituents 501-1000 from crowding aggregations.
      limit: edgeInt(params, "limit", 10, 1, 1000),
    };
    const offset = edgeInt(params, "offset", 0, 0, 10000);
    if (offset > 0) body.offset = offset;
    if (edgeBool(params, "summaryOnly") || edgeBool(params, "summary_only")) {
      body.summary_only = true;
    }
    return {
      origin: "shorts",
      path: "/shorts.v1alpha1.ShortedStocksService/GetTopShorts",
      body,
    };
  }

  if (path === `${EDGE_READ_PREFIX}/industry-treemap`) {
    const body = {
      period: edgePeriod(params, "period", "3m"),
      limit: edgeInt(params, "limit", 20, 1, 500),
    };
    const viewMode = params.get("viewMode") ?? params.get("view_mode");
    if (viewMode !== null && viewMode !== "") {
      const numericViewMode = Number(viewMode);
      body.view_mode = Number.isFinite(numericViewMode) ? numericViewMode : viewMode;
    }
    return {
      origin: "shorts",
      path: "/shorts.v1alpha1.ShortedStocksService/GetIndustryTreeMap",
      body,
    };
  }

  if (path === `${EDGE_READ_PREFIX}/available-dates`) {
    const body = {};
    const limit = params.get("limit");
    const before = params.get("before");
    if (limit !== null && limit !== "") body.limit = edgeInt(params, "limit", 20, 1, 500);
    if (before) body.before = before;
    return {
      origin: "shorts",
      path: "/shorts.v1alpha1.ShortedStocksService/GetAvailableDates",
      body,
    };
  }

  if (path === `${EDGE_READ_PREFIX}/market-by-date`) {
    const date = params.get("date");
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    return {
      origin: "shorts",
      path: "/shorts.v1alpha1.ShortedStocksService/GetMarketByDate",
      body: {
        date,
        limit: edgeInt(params, "limit", 50, 1, 1000),
        offset: edgeInt(params, "offset", 0, 0, 100000),
      },
    };
  }

  if (path === `${EDGE_READ_PREFIX}/weekly-report`) {
    const weekSlug = params.get("weekSlug") ?? params.get("week_slug");
    const period = params.get("period");
    return {
      origin: "shorts",
      path: "/shorts.v1alpha1.ShortedStocksService/GetWeeklyReport",
      body: weekSlug ? { week_slug: weekSlug } : { period: period || "1w" },
    };
  }

  if (path === `${EDGE_READ_PREFIX}/news`) {
    return {
      origin: "shorts",
      path: "/shorts.v1alpha1.ShortedStocksService/GetNews",
      body: { limit: edgeInt(params, "limit", 20, 1, 100) },
    };
  }

  if (path === `${EDGE_READ_PREFIX}/announcements`) {
    return {
      origin: "shorts",
      path: "/shorts.v1alpha1.ShortedStocksService/GetAnnouncement",
      body: { limit: edgeInt(params, "limit", 20, 1, 100) },
    };
  }

  if (path === `${EDGE_READ_PREFIX}/news/market`) {
    const body = { limit: edgeInt(params, "limit", 50, 1, 100) };
    if (edgeBool(params, "priceSensitiveOnly") || edgeBool(params, "price_sensitive_only")) {
      body.price_sensitive_only = true;
    }
    return {
      origin: "shorts",
      path: "/shorts.v1alpha1.ShortedStocksService/GetMarketNews",
      body,
    };
  }

  const stockMatch = new RegExp(`^${EDGE_READ_PREFIX}/stock/([^/]+)(?:/(details|data|news))?$`).exec(path);
  if (stockMatch) {
    const code = edgeStockCode(stockMatch[1]);
    if (!code) return null;
    const variant = stockMatch[2] || "summary";
    if (variant === "details") {
      return {
        origin: "shorts",
        path: "/shorts.v1alpha1.ShortedStocksService/GetStockDetails",
        body: { product_code: code },
      };
    }
    if (variant === "data") {
      return {
        origin: "shorts",
        path: "/shorts.v1alpha1.ShortedStocksService/GetStockData",
        body: { product_code: code, period: edgePeriod(params, "period", "3m") },
      };
    }
    if (variant === "news") {
      return {
        origin: "shorts",
        path: "/shorts.v1alpha1.ShortedStocksService/GetStockNews",
        body: { stock_code: code, limit: edgeInt(params, "limit", 10, 1, 100) },
      };
    }
    return {
      origin: "shorts",
      path: "/shorts.v1alpha1.ShortedStocksService/GetStock",
      body: { product_code: code },
    };
  }

  const marketStockMatch = new RegExp(`^${EDGE_READ_PREFIX}/market/stock/([^/]+)/(price|history)$`).exec(path);
  if (marketStockMatch) {
    const code = edgeStockCode(marketStockMatch[1]);
    if (!code) return null;
    if (marketStockMatch[2] === "price") {
      return {
        origin: "market",
        path: "/marketdata.v1.MarketDataService/GetStockPrice",
        body: { stock_code: code },
      };
    }
    return {
      origin: "market",
      path: "/marketdata.v1.MarketDataService/GetHistoricalPrices",
      body: { stock_code: code, period: edgePeriod(params, "period", "3m") },
    };
  }

  if (path === `${EDGE_READ_PREFIX}/market/stocks/prices`) {
    const codes = (params.get("codes") || "")
      .split(",")
      .map((code) => edgeStockCode(code))
      .filter(Boolean)
      .slice(0, 50);
    if (codes.length === 0) return null;
    return {
      origin: "market",
      path: "/marketdata.v1.MarketDataService/GetMultipleStockPrices",
      body: { stock_codes: codes },
    };
  }

  return null;
}

function edgePeriod(params, key, fallback) {
  const raw = params.get(key);
  return (raw && raw.trim() ? raw.trim().toLowerCase() : fallback).replace(/\s+/g, "");
}

function edgeInt(params, key, fallback, min, max) {
  const raw = params.get(key);
  const value = raw === null || raw === "" ? fallback : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function edgeBool(params, key) {
  const raw = params.get(key);
  if (raw === null) return false;
  return ["1", "true", "yes", "y", "on"].includes(raw.trim().toLowerCase());
}

function edgeStockCode(value) {
  const code = decodeURIComponent(value || "").trim().toUpperCase();
  return /^[A-Z0-9.-]{1,16}$/.test(code) ? code : "";
}

function positiveInt(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

async function withEdgeAnalytics(request, env, responseOrPromise, origin, cacheTtl, started) {
  const response = await responseOrPromise;
  logEdgeAnalytics(request, env, response, origin, cacheTtl, started);
  return response;
}

function logEdgeAnalytics(request, env, response, origin, cacheTtl, started) {
  const sampleRate = clampSampleRate(parseFloat(env.EDGE_ANALYTICS_SAMPLE_RATE || "0.01"));
  if (sampleRate <= 0 || Math.random() > sampleRate) {
    return;
  }

  try {
    console.log(JSON.stringify(buildEdgeAnalyticsEvent(request, response, {
      origin,
      cacheTtl,
      started,
      now: Date.now(),
    })));
  } catch (_) {
    // Analytics must never affect request handling.
  }
}

function clampSampleRate(value) {
  if (!Number.isFinite(value)) return 0.01;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function normalizeAnalyticsPath(path) {
  if (path.includes("/shorts.v1alpha1.") || path.includes("/marketdata.v1.") || path.includes("/chat.v1.") || path.includes("/register.v1.")) {
    return path;
  }
  if (path.startsWith(`${EDGE_READ_PREFIX}/`)) return `${EDGE_READ_PREFIX}/*`;
  if (path.startsWith("/_next/static/")) return "/_next/static/*";
  if (path.startsWith("/_next/data/")) return "/_next/data/*";
  if (/\.(png|jpe?g|gif|svg|webp|avif|ico)$/i.test(path)) return "/*image";
  if (/\.(woff2?|ttf|eot)$/i.test(path)) return "/*font";
  return path === "/" ? "/" : "/*page";
}

export function buildEdgeAnalyticsEvent(request, response, options) {
  const url = new URL(request.url);
  const cacheStatus = response.headers.get("X-Shorted-Cache") || "UNKNOWN";
  const rpc = parseRpcPath(url.pathname);
  const routeGroup = normalizeRouteGroup(url.hostname, url.pathname);
  const contentLength = parseInt(response.headers.get("content-length") || "0", 10);
  const cf = request.cf || {};

  return {
    type: "edge_request",
    host: url.hostname,
    path: normalizeAnalyticsPath(url.pathname),
    route_group: routeGroup,
    referer_group: normalizeRefererGroup(request.headers.get("referer")),
    feature: resolveFeature(url.pathname, options.origin, rpc.api_family),
    api_family: rpc.api_family || (url.pathname.startsWith("/api/") ? "next-api" : ""),
    rpc_method: rpc.rpc_method,
    method: request.method,
    origin: options.origin,
    cache_status: cacheStatus,
    cacheable: isCacheableAnalyticsEvent(cacheStatus, options.cacheTtl || 0),
    status: response.status,
    cache_ttl_seconds: options.cacheTtl || 0,
    duration_ms: Math.max(0, options.now - options.started),
    response_bytes: Number.isFinite(contentLength) ? contentLength : 0,
    cf_ray: request.headers.get("cf-ray") || "",
    cf_colo: typeof cf.colo === "string" ? cf.colo : "",
    cf_client_bot: Boolean(cf.clientBot),
  };
}

export function normalizeRouteGroup(host, path) {
  const rpc = parseRpcPath(path);
  if (rpc.api_family && rpc.rpc_method) {
    return `/rpc/${rpc.api_family}/${rpc.rpc_method}`;
  }

  if (path === "/") return "/";
  if (path.startsWith("/_next/static/")) return "/_next/static/*";
  if (path.startsWith("/_next/data/")) return "/_next/data/*";
  if (/\.(png|jpe?g|gif|svg|webp|avif|ico)$/i.test(path)) return "/*image";
  if (/\.(woff2?|ttf|eot)$/i.test(path)) return "/*font";

  if (/^\/shorts\/[^/]+\/community\/[^/]+/.test(path)) return "/shorts/[code]/community/[threadId]";
  if (/^\/shorts\/[^/]+\/news/.test(path)) return "/shorts/[code]/news";
  if (/^\/shorts\/[^/]+/.test(path)) return "/shorts/[code]";
  if (/^\/insider-trading\/[^/]+/.test(path)) return "/insider-trading/[code]";

  if (/^\/api\/community\/reports/.test(path)) return "/api/community/reports";
  if (/^\/api\/community\/votes/.test(path)) return "/api/community/votes";
  if (/^\/api\/community\/[^/]+\/threads\/[^/]+\/comments/.test(path)) return "/api/community/[code]/threads/[threadId]/comments";
  if (/^\/api\/community\/[^/]+\/threads\/[^/]+/.test(path)) return "/api/community/[code]/threads/[threadId]";
  if (/^\/api\/community\/[^/]+\/threads/.test(path)) return "/api/community/[code]/threads";
  if (/^\/api\/community\/[^/]+\/pulse\/[^/]+\/replies/.test(path)) return "/api/community/[code]/pulse/[pulseId]/replies";
  if (/^\/api\/community\/[^/]+\/pulse/.test(path)) return "/api/community/[code]/pulse";
  if (/^\/api\/community\/[^/]+\/summary/.test(path)) return "/api/community/[code]/summary";

  if (path.startsWith("/api/market-data/")) return "/api/market-data/*";
  if (path.startsWith("/api/search/")) return "/api/search/*";
  if (path.startsWith("/api/stocks/multiple")) return "/api/stocks/multiple";
  if (path.startsWith("/api/admin/")) return "/api/admin/*";
  if (path.startsWith("/api/")) return "/api/*";

  if (path.startsWith(`${EDGE_READ_PREFIX}/`)) return `${EDGE_READ_PREFIX}/*`;
  if (path.startsWith("/portfolio")) return "/portfolio";
  if (path.startsWith("/dashboards")) return "/dashboards";
  if (path.startsWith("/chat")) return "/chat";
  if (path.startsWith("/search")) return "/search";
  if (path.startsWith("/stocks")) return "/stocks";
  if (path.startsWith("/topShortsView")) return "/top-shorts";

  return host === FRONTEND_HOST || host === `www.${FRONTEND_HOST}` ? "/*page" : path;
}

function normalizeRefererGroup(referer) {
  if (!referer) return "";
  try {
    const url = new URL(referer);
    return normalizeRouteGroup(url.hostname, url.pathname);
  } catch (_) {
    return "";
  }
}

function parseRpcPath(path) {
  const match = /^\/([^/]+)\/([^/]+)$/.exec(path);
  if (!match) {
    return { api_family: "", rpc_method: "" };
  }

  const service = match[1];
  const rpcMethod = match[2];
  if (service.includes("shorts.v1alpha1.")) {
    return { api_family: "shorts", rpc_method: rpcMethod };
  }
  if (service.includes("marketdata.v1.")) {
    return { api_family: "market-data", rpc_method: rpcMethod };
  }
  if (service.includes("chat.v1.")) {
    return { api_family: "chat", rpc_method: rpcMethod };
  }
  if (service.includes("register.v1.")) {
    return { api_family: "auth", rpc_method: rpcMethod };
  }
  return { api_family: "", rpc_method: "" };
}

function resolveFeature(path, origin, apiFamily) {
  if (apiFamily) return apiFamily;
  if (path.startsWith("/api/community/") || /^\/shorts\/[^/]+\/community/.test(path)) return "community";
  if (path.startsWith("/portfolio")) return "portfolio";
  if (path.startsWith("/dashboards")) return "dashboards";
  if (path.startsWith("/chat")) return "chat";
  if (path.startsWith("/api/search/") || path.startsWith("/search")) return "search";
  if (path.startsWith("/api/market-data/")) return "market-data";
  if (path.startsWith(`${EDGE_READ_PREFIX}/`)) return "edge-read";
  if (path.startsWith("/shorts") || path.startsWith("/topShortsView")) return "shorts";
  if (path.startsWith("/api/admin/") || path.startsWith("/admin")) return "admin";
  return origin || "unknown";
}

function isCacheableAnalyticsEvent(cacheStatus, cacheTtl) {
  return cacheTtl > 0 || ["HIT", "MISS", "KV", "HOT"].includes(cacheStatus);
}

/**
 * Determine the cache TTL for a Shorts API path based on the RPC method name.
 * ASIC data changes daily (T+2 delay, weekly aggregate Fridays), so longer
 * TTLs are safe and reduce unnecessary origin fetches.
 */
export function resolveShortsTtl(path, defaults) {
  if (/GetTopShorts|GetIndustryTreeMap|GetIndustryIntelligence|GetShortsTreeMap|GetWeeklyReport|GetMarketByDate|GetAvailableDates/.test(path)) {
    return defaults.cacheTtlTopShorts; // 300s (5min) — safe for ASIC data
  }
  if (/GetNews|GetAnnouncement|GetMarketNews/.test(path)) {
    return defaults.cacheTtlNews; // 300s (5min)
  }
  if (/GetStock|GetStockDetails|GetStockData|GetStockNews|GetSearch|GetWatchlist|GetDirectorTrades|GetPeerComparison|GetDividendHistory|GetStockFinancialHighlights/.test(path)) {
    return defaults.cacheTtlStockData; // 180s (3min) — balance freshness vs origin load
  }
  return defaults.cacheTtlDefault;
}

/**
 * Build a cache key suffix for the in-memory hot cache.
 * For POST requests this hashes the request body so different request
 * parameters (e.g. productCode, period) get distinct cache entries.
 *
 * BUG FIX: previously this returned `path` for all POST requests, which
 * meant the first response cached for /GetStockData served every
 * subsequent call regardless of the stock code being requested. The
 * outer Cache API + KV layers correctly hash the body — only the
 * in-memory hot tier was poisoning across requests.
 */
async function buildHotCacheKey(request, path, cacheVersion = DEFAULT_CACHE_VERSION) {
  if (request.method === "POST") {
    const bodyText = await request.clone().text();
    const bodyHash = hashStringSync(bodyText);
    return `${cacheVersion}:${path}:${bodyHash}`;
  }
  return `${cacheVersion}:${path}`;
}

/**
 * Handle a cacheable request: hot cache -> Cache API -> KV -> origin.
 * KV is checked on Cache API miss for pre-warmed endpoints.
 * This means users get KV responses even when CF cache has expired between pre-warms.
 */
async function handleCachedRequest(request, url, env, ctx, origin, cacheTtl, cacheVersion) {
  const path = url.pathname;
  let requestBody = undefined;

  try {
    const activeCacheVersion = cacheVersion || await getCacheVersion(env);
    let kvKey = null; // declared early so both KV-hit and MISS branches can use it
    requestBody = request.method !== "GET" && request.method !== "HEAD"
      ? await request.clone().arrayBuffer()
      : undefined;
    const freshBody = () => requestBody ? requestBody.slice(0) : undefined;
    const cache = caches.default;
    const cacheKey = await buildCacheKey(request, url, activeCacheVersion);

    // Check edge cache (fastest, per-PoP)
    const cached = await cache.match(cacheKey);
    if (cached) {
      const resp = new Response(cached.body, cached);
      stampEdgeHeaders(resp, "HIT");
      return resp;
    }

    // Cache miss — check KV if this is a pre-warmed endpoint
    // KV is globally consistent: any PoP can read the same pre-warmed data
    kvKey = await buildKvCacheKey(request, path, activeCacheVersion);
    if (kvKey && env.EDGE_KV) {
      try {
        const kvValue = await env.EDGE_KV.get(kvKey);
        if (kvValue) {
          // KV hit — serve it and repopulate CF cache in background
          const clientResp = new Response(kvValue, {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
          stampEdgeHeaders(clientResp, "KV");
          clientResp.headers.set("Cache-Control", edgeCacheControl(request.method, cacheTtl));

          // Non-blocking: repopulate CF cache for this PoP from KV. A KV hit
          // should not immediately create another origin request.
          safeWaitUntil(ctx, (async () => {
            try {
              const cacheResp = new Response(kvValue, {
                status: 200,
                headers: { "Content-Type": "application/json" },
              });
              stampEdgeHeaders(cacheResp, "HIT");
              cacheResp.headers.set("Cache-Control", edgeCacheControl(request.method, cacheTtl));
              await cache.put(cacheKey, cacheResp);
            } catch (_) { /* non-fatal */ }
          })());

          return clientResp;
        }
      } catch (_) {
        // KV read failed — fall through to origin (don't block on KV errors)
      }
    }

    // Cache miss + KV miss — fetch from origin
    const originUrl = buildOriginUrl(origin, url);
    const originResp = await fetch(originUrl, {
      method: request.method,
      headers: filterRequestHeaders(request.headers),
      body: freshBody(),
    });

    // Only cache successful responses
    if (!originResp.ok) {
      const resp = new Response(originResp.body, originResp);
      stampEdgeHeaders(resp, "BYPASS");
      return resp;
    }

    // Read body so we can use it for both the response and the cache
    const body = await originResp.arrayBuffer();

    // Response to return to client
    const clientResp = new Response(body, {
      status: originResp.status,
      headers: new Headers(originResp.headers),
    });
    stampEdgeHeaders(clientResp, "MISS");
    clientResp.headers.set("Cache-Control", edgeCacheControl(request.method, cacheTtl));

    // Response to store in CF cache
    const cacheResp = new Response(body.slice(0), {
      status: originResp.status,
      headers: cacheableResponseHeaders(originResp, cacheTtl, request.method),
    });
    stampEdgeHeaders(cacheResp, "HIT");

    // Store in CF edge cache (non-blocking)
    safeWaitUntil(ctx, () => cache.put(cacheKey, cacheResp));

    // Cache-aside: async write to KV on MISS.
    // Next user (any geo) hits KV instead of origin.
    // Body has already been read into `body` ArrayBuffer — convert back to text for KV.
    // kvKey is already computed above in this function.
    if (kvKey && env.EDGE_KV) {
      safeWaitUntil(ctx, (async () => {
        try {
          const text = new TextDecoder().decode(body);
          // Use the same TTL as CF cache, capped at 3600s for cache-aside writes.
          // KV is a safety net between pre-warms; prewarm writes 24h for static data.
          const kvTtl = Math.min(cacheTtl, 3600); // cap at 1h for cache-aside writes; prewarm uses 24h for static data
          await env.EDGE_KV.put(kvKey, text, { expirationTtl: kvTtl });
        } catch (_) { /* non-fatal */ }
      })());
    }

    return clientResp;
  } catch {
    // If caching fails, fall through to origin
    const originUrl = buildOriginUrl(origin, url);
    if (requestBody === undefined && request.method !== "GET" && request.method !== "HEAD") {
      requestBody = await request.clone().arrayBuffer();
    }
    return fetch(originUrl, {
      method: request.method,
      headers: filterRequestHeaders(request.headers),
      body: requestBody ? requestBody.slice(0) : undefined,
    });
  }
}

function safeWaitUntil(ctx, task) {
  try {
    const promise = typeof task === "function" ? task() : task;
    if (!promise || typeof promise.then !== "function") return;
    ctx.waitUntil(promise.catch(() => {}));
  } catch (_) {
    // Background cache/KV writes must never fail the user request.
  }
}

/**
 * Cache-Control for worker-managed cache entries.
 *
 * `stale-while-revalidate` is only safe when the cache key is a REAL GET.
 * The Cache API accepts GET keys only, so buildCacheKey() stores a POST RPC
 * under a *synthesized* GET (path + `_bh` body hash). Cloudflare honours SWR
 * on the stored entry and revalidates it by fetching that key — i.e. a
 * body-less GET against a POST-only Connect handler, which can never answer.
 *
 * Measured over 24h on 2026-08-23: every one of the 10,884 revalidations
 * (7,295 miss + 3,589 stale) returned 504 with originResponseStatus=0, and
 * they were 100% of the 504s on api.shorted.com.au. Worse than the wasted
 * origin traffic: the revalidation never succeeded, so entries were served
 * stale until eviction instead of refreshing — silent staleness.
 *
 * So: SWR for genuine GETs, plain s-maxage for POST-derived entries. Dropping
 * SWR costs a MISS at expiry, which fetches with the correct POST body and
 * actually refreshes.
 */
/** True for Connect-RPC service paths, which are POST-only at the origin. */
export function isConnectRpcPath(path) {
  return (
    path.includes("/shorts.v1alpha1.") ||
    path.includes("/marketdata.v1.") ||
    path.includes("/chat.v1.") ||
    path.includes("/register.v1.")
  );
}

export function edgeCacheControl(method, cacheTtl) {
  return method === "GET"
    ? `s-maxage=${cacheTtl}, stale-while-revalidate=${cacheTtl}`
    : `s-maxage=${cacheTtl}`;
}

function cacheableResponseHeaders(originResp, cacheTtl, method) {
  const headers = new Headers();
  const contentType = originResp.headers.get("Content-Type") || originResp.headers.get("content-type");
  if (contentType) {
    headers.set("Content-Type", contentType);
  }
  headers.set("Cache-Control", edgeCacheControl(method, cacheTtl));
  return headers;
}

/**
 * Build a KV cache key for cacheable endpoints.
 * Uses the request body for deterministic hashing (matches prewarm.js keys).
 * Returns null if the endpoint is not KV-cacheable.
 *
 * Cacheable endpoints:
 *   - Shorts API: GetTopShorts, GetIndustryTreeMap, GetWeeklyReport,
 *                 GetAvailableDates, GetStock, GetNews, GetAnnouncement
 *   - Market Data: GetStockPrice, GetMultipleStockPrices, GetHistoricalPrices
 */
export async function buildKvCacheKey(request, path, cacheVersion = DEFAULT_CACHE_VERSION) {
  if (!/GetTopShorts|GetIndustryTreeMap|GetIndustryIntelligence|GetShortsTreeMap|GetWeeklyReport|GetAvailableDates|GetMarketByDate|GetStock$|GetStockDetails|GetStockData|GetStockNews|GetStockFinancialHighlights|GetNews|GetAnnouncement|GetMarketNews|GetStockPrice|GetMultipleStockPrices|GetHistoricalPrices/.test(path)) {
    return null;
  }
  if (request.method === "POST") {
    const bodyText = await request.clone().text();
    const bodyHash = hashStringSync(bodyText);
    const pathClean = path.replace(/\//g, "_").replace(/^_/, "");
    return `prewarm:${cacheVersion}:${pathClean}:${bodyHash}`;
  }
  return null;
}

/**
 * Deterministic hash without async crypto API (for KV key consistency).
 * Uses djb2 hash — fast and good enough for cache key determinism.
 */
function hashStringSync(text) {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Proxy a request to an origin without caching. Used for pass-through routes.
 */
async function proxyWithHeaders(request, origin, cacheStatus) {
  const reqUrl = new URL(request.url);
  const originUrl = buildOriginUrl(origin, reqUrl);
  const requestBody = request.method !== "GET" && request.method !== "HEAD"
    ? await request.clone().arrayBuffer()
    : undefined;
  const freshBody = () => requestBody ? requestBody.slice(0) : undefined;

  try {
    const resp = await fetch(originUrl, {
      method: request.method,
      headers: filterRequestHeaders(request.headers),
      body: freshBody(),
    });
    const clientResp = new Response(resp.body, resp);
    stampEdgeHeaders(clientResp, cacheStatus);
    return clientResp;
  } catch {
    return fetch(originUrl, {
      method: request.method,
      headers: filterRequestHeaders(request.headers),
      body: freshBody(),
    });
  }
}

/**
 * Proxy frontend traffic (shorted.com.au) to Vercel.
 * - Strips hop-by-hop CF headers and forwards the real client IP via CF-Connecting-IP.
 *   This is critical: Vercel's Upstash Redis rate limiting in middleware.ts uses
 *   request.ip (which reads CF-Connecting-IP on Vercel) to identify clients.
 * - No edge caching: Vercel handles HTML/asset caching at its CDN layer.
 * - Cloudflare DDoS + WAF protect all frontend traffic at the proxy layer.
 */
async function proxyFrontend(request, env, frontendOrigin) {
  const reqUrl = new URL(request.url);
  const originUrl = buildOriginUrl(frontendOrigin, reqUrl);
  const requestBody = request.method !== "GET" && request.method !== "HEAD"
    ? await request.clone().arrayBuffer()
    : undefined;
  const freshBody = () => requestBody ? requestBody.slice(0) : undefined;

  // Build headers for Vercel — forward the real client IP
  const headers = new Headers();
  request.headers.forEach((value, key) => {
    // Skip hop-by-hop and Cloudflare-specific headers; add them fresh for Vercel
    if (["host", "x-forwarded-for", "x-real-ip", "cf-connecting-ip"].includes(key.toLowerCase())) {
      return;
    }
    headers.set(key, value);
  });

  // Critical: forward CF-Connecting-IP so Vercel sees the real client IP
  // (Vercel's `request.ip` reads this header when traffic comes through CF proxy)
  const cfConnectingIp = request.headers.get("cf-connecting-ip");
  if (cfConnectingIp) {
    headers.set("X-Real-IP", cfConnectingIp);
    headers.set("X-Forwarded-For", cfConnectingIp);
  }
  // Override Host so Vercel routes correctly
  headers.set("Host", "shorted.com.au");

  try {
    const resp = await fetch(originUrl, {
      method: request.method,
      headers,
      body: freshBody(),
    });

    const clientResp = new Response(resp.body, resp);
    // Mark as proxied through CF edge for observability
    clientResp.headers.set("X-Shorted-Edge", "cloudflare");
    clientResp.headers.set("X-Shorted-Cache", "BYPASS");
    return clientResp;
  } catch {
    return fetch(originUrl, {
      method: request.method,
      headers,
      body: freshBody(),
    });
  }
}

/**
 * Build the full origin URL from the base origin and the incoming request URL.
 * Preserves path, query string, and hash.
 */
function buildOriginUrl(origin, url) {
  return `${origin}${url.pathname}${url.search}${url.hash}`;
}

/**
 * Filter request headers to remove hop-by-hop and Cloudflare-specific headers
 * that should not be forwarded to the origin.
 */
function filterRequestHeaders(headers) {
  const filtered = new Headers(headers);
  const strip = [
    "cf-connecting-ip",
    "cf-ipcountry",
    "cf-ray",
    "cf-visitor",
    "cf-worker",
    "host",
    "x-forwarded-for",
    "x-forwarded-proto",
  ];
  for (const h of strip) {
    filtered.delete(h);
  }
  return filtered;
}

/**
 * Stamp edge response headers on a response.
 */
function stampEdgeHeaders(resp, cacheStatus) {
  resp.headers.set("X-Shorted-Cache", cacheStatus);
  resp.headers.set("X-Shorted-Edge", "cloudflare");
}

/**
 * Build a deterministic cache key from the request.
 * For POST requests, incorporates a SHA-256 hash of the request body.
 *
 * NOTE: Auth is intentionally NOT included in the cache key for public read-only
 * endpoints (GetTopShorts, GetStock, GetIndustryTreeMap, etc.). These endpoints
 * return the same data regardless of the user's auth level. Including auth in
 * the cache key fragments the cache unnecessarily — every unauthenticated request
 * would populate its own cache entry for public data.
 *
 * Auth IS included for private endpoints (enrichment, admin, sync status).
 */
async function buildCacheKey(request, url, cacheVersion = DEFAULT_CACHE_VERSION) {
  const cacheUrl = new URL(url.toString());
  const path = cacheUrl.pathname;
  cacheUrl.searchParams.set("_cv", cacheVersion);

  // For public read endpoints, cache key does NOT include auth.
  // This means unauthenticated and authenticated users share the same cache entry,
  // which is correct — the data is identical.
  const isPublicRead = isPublicReadEndpoint(path);

  if (request.method === "POST") {
    const body = await request.clone().text();
    const bodyHash = await hashString(body);
    cacheUrl.searchParams.set("_bh", bodyHash);
  }

  // Only include auth for private endpoints
  if (!isPublicRead) {
    const authHeader = request.headers.get("Authorization") || "anon";
    const authHash = await hashString(authHeader);
    cacheUrl.searchParams.set("_a", authHash.substring(0, 8));
  }

  // Cache API only supports GET
  return new Request(cacheUrl.toString(), { method: "GET" });
}

/**
 * Determine if a path is a public read-only endpoint that should share
 * cache entries across all auth levels.
 */
function isPublicReadEndpoint(path) {
  return (
    /GetTopShorts|GetShortsTreeMap|GetWeeklyReport|GetMarketByDate|GetAvailableDates/.test(path) ||
    /GetStock$|GetStockDetails|GetStockData|GetStockNews|GetStockFinancialHighlights/.test(path) ||
    /GetNews|GetAnnouncement|GetMarketNews/.test(path) ||
    /GetSearch|GetDirectorTrades|GetPeerComparison|GetDividendHistory/.test(path) ||
    /marketdata\.v1\./.test(path)
  );
}

/**
 * Handle cache purge requests.
 * Bumps a shared cache version so hot cache, Cache API, and KV reads stop
 * resolving stale entries immediately. Old Cache API objects expire by TTL.
 */
async function handlePurge(env) {
  const hotEntriesCleared = hotCache.size;
  hotCache.clear();

  if (!env.EDGE_KV) {
    return new Response(
      JSON.stringify({
        status: "failed",
        message: "EDGE_KV is required to purge shared edge caches",
        hotEntriesCleared,
      }),
      {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const cacheVersion = newCacheVersion();
  try {
    await env.EDGE_KV.put(CACHE_VERSION_KEY, cacheVersion);
    setCacheVersionMemo(cacheVersion);
  } catch (err) {
    return new Response(
      JSON.stringify({
        status: "failed",
        message: "Unable to update shared cache version",
        error: err instanceof Error ? err.message : String(err),
        hotEntriesCleared,
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  return new Response(
    JSON.stringify({
      status: "purged",
      cacheVersion,
      hotEntriesCleared,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
}

/**
 * SHA-256 hash of a string, returned as hex.
 */
async function hashString(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
