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
  } catch (err) {
    // A failing control read means a cache PURGE cannot take effect — the
    // worker keeps serving the old cache version. Worth a loud line.
    recordKvError(env, null, { op: "version-get", keyKind: "control", error: err });
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
  // api host, /mcp, anonymous. Its own class because an MCP turn is not an
  // API request — it is a HANDSHAKE followed by a burst of tool calls, issued
  // SEQUENTIALLY by the SDK, and Phase 2 measured a "compare these five
  // stocks" turn crossing api-anon's 10/10s well before the model finished
  // thinking. Elapsed time is no mitigation when the calls are serialised.
  //
  // 60/10s and 300/60s: roughly six times api-anon, chosen so a normal agent
  // turn never touches it while a scripted loop still does. It is NOT exempt
  // and must not become so — /mcp is an unauthenticated tool surface, and
  // until the app-layer limiter (services/pkg/ratelimit) is deployed the edge
  // is its ONLY ceiling. Afterwards it remains the abuse ceiling for callers
  // who never authenticate.
  //
  // Authenticated MCP callers carry a bearer token, so they resolve to
  // api-key above and are not affected by these numbers.
  "mcp-anon": {
    prefix: "m",
    burstBinding: "MCP_ANON_BURST_RATE_LIMITER",
    burstVar: "RATE_LIMIT_MCP_ANON_BURST",
    burstDefault: 60,
    sustainedBinding: "MCP_ANON_RATE_LIMITER",
    sustainedVar: "RATE_LIMIT_MCP_ANON_LIMIT",
    sustainedDefault: 300,
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

    // Once per ISOLATE (not per request): a snapshot of what this running copy
    // of the worker believes is configured. This is the deploy feedback loop —
    // see recordEdgeConfigOnce.
    recordEdgeConfigOnce(env, request);

    // First-party bypass usage as a FIRST-CLASS event, emitted here rather than
    // inside the limiter. A bypass that short-circuits before any bucket — or
    // one used while enforcement is disabled, or on an ineligible path — never
    // produces an edge_rate_limit event at all, so a leaked E2E secret would be
    // completely silent. This runs before every routing decision so it cannot
    // be skipped by one.
    recordBypassUsage(request, env, path, hostname);

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
      return withEdgeAnalytics(request, env, proxyWithHeaders(request, shortsApiOrigin, "BYPASS", env), "shorts", 0, started);
    }

    // MCP -> never cached, explicitly.
    //
    // An MCP request is a JSON-RPC POST, and POSTs are not cached today, so
    // this is currently belt-and-braces — which is the point. A cached MCP
    // response is not a stale page, it is ONE CLIENT'S SESSION served to
    // ANOTHER: tool results, and eventually results computed under someone
    // else's authorization. Phase 2 verified /mcp was BYPASS but nothing
    // enforced it, so a future caching rule that keyed on path or method could
    // have quietly made it cacheable. Now it cannot, and a test says so.
    if (isMcpPath(path)) {
      return withEdgeAnalytics(request, env, proxyWithHeaders(request, shortsApiOrigin, "BYPASS", env), "shorts", 0, started);
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
      return withEdgeAnalytics(request, env, proxyWithHeaders(request, shortsApiOrigin, "BYPASS", env), "shorts", 0, started);
    }

    // Cache purge endpoint (requires shared secret)
    if (path === "/api/cache/purge" && request.method === "POST") {
      const purgeBody = await request.text();
      if (!env.CACHE_PURGE_SECRET || purgeBody !== env.CACHE_PURGE_SECRET) {
        // The purge body IS the shared secret, so nothing from the request is
        // echoed — only the bounded reason. Repeated unauthorized attempts are
        // someone probing for it.
        recordCachePurge(env, request, {
          outcome: "unauthorized",
          reason: env.CACHE_PURGE_SECRET ? "bad-secret" : "secret-unconfigured",
          durationMs: Date.now() - started,
        });
        return withEdgeAnalytics(request, env, new Response("Unauthorized", { status: 401 }), "edge-control", 0, started);
      }
      return withEdgeAnalytics(request, env, handlePurge(env, request, started), "edge-control", 0, started);
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
      return withEdgeAnalytics(request, env, proxyWithHeaders(request, shortsApiOrigin, "BYPASS", env), "shorts", 0, started);
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
    return withEdgeAnalytics(request, env, proxyWithHeaders(request, shortsApiOrigin, "BYPASS", env), "shorts", 0, started);
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
 * A THIRD outcome exists, and it is the one that matters most operationally:
 *
 *   3. "ssr-unverified" — the UA carries the first-party marker but the secret
 *      is absent, stale or mismatched. This USED to fall through to "" and land
 *      the request in `api-anon` (10 req / 10s), which is how our own renderer
 *      got 429'd ~3,500x/day in August 2026: a CI-side `vercel build` prerender
 *      cannot read Vercel's SENSITIVE env vars, so it rendered every page
 *      without the secret and hammered the public host from one runner IP.
 *
 *      Failing CLOSED like that is the wrong default for first-party traffic.
 *      An unverified claim now routes to the SAME generous `first-party`
 *      runaway bucket as a verified one, and shouts about it (edge_bypass_used
 *      outcome=rejected/unconfigured, emitted unsampled). The secret's job is
 *      to be an OPTIMISATION — it is what lets verified traffic skip the zone
 *      rule entirely — never the thing standing between us and an outage.
 *
 *      THE TRADEOFF, STATED PLAINLY: anyone can spoof a user-agent, so a
 *      scraper that sends `shorted-web-ssr` now gets 600/10s instead of 10/10s.
 *      That is deliberate. 600/10s is still a hard runaway ceiling that
 *      protects the origin, the app-layer per-tier limiter and monthly quota
 *      are untouched (they run after auth, where a spoofed UA buys nothing),
 *      and the zone WAF/DDoS layers still apply. Rate-limiting our own
 *      rendering is a self-inflicted outage; letting a spoofer have a higher
 *      abuse ceiling is a cost. The costs are not comparable.
 *
 * @param {Request} request
 * @param {Record<string, string>} env
 * @returns {"" | "testing" | "ssr" | "ssr-unverified"} the matched bypass class, or ""
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
  if (ua.includes(ssrUa)) {
    return ssrSecret && secretsMatch(request.headers.get(ssrHeader) || "", ssrSecret)
      ? "ssr"
      : // Marker present, proof missing. Generous bucket, loud event — never
        // the anonymous bucket. See the block comment above.
        "ssr-unverified";
  }

  return "";
}

/**
 * Does this bypass class belong in the first-party runaway bucket?
 *
 * Both the verified and the unverified first-party claim do. The difference
 * between them is entirely in the OBSERVABILITY (and in whether the zone-level
 * skip rule let the request past without consulting the worker at all), never
 * in which ceiling applies.
 *
 * @param {string} bypass
 */
export function isFirstPartyBypassClass(bypass) {
  return bypass === "ssr" || bypass === "ssr-unverified";
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
 *   2. api surface -> a first-party caller (SSR/ISR or a Vercel rewrite) gets
 *      `first-party`, whether or not the SSR bypass secret verified. This MUST
 *      come before the anon check: those requests all share a few Vercel egress
 *      IPs and would otherwise collapse into one anon bucket and 429 real users
 *      — and an unverifiable claim is a misconfiguration signal, not a licence
 *      to throttle our own rendering (see resolveRateLimitBypass).
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
 * @param {"" | "testing" | "ssr" | "ssr-unverified"} bypass the already-resolved bypass class
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

  if (isFirstPartyBypassClass(bypass)) {
    // Keyed by egress IP: one runaway Vercel instance is contained without
    // penalising the others.
    //
    // `ssr-unverified` lands here TOO, on purpose. A first-party claim we
    // cannot prove is a misconfiguration far more often than it is an attack
    // (a rotated secret, an env var that missed a deploy, a CI build that
    // cannot read a sensitive var), and the cost of guessing "attack" is
    // 429ing our own renderer. Guess "us", shout about it, and keep a real
    // runaway ceiling in place either way.
    return { bucketClass: "first-party", key: `f:${clientIp(request)}` };
  }

  const token = extractRateLimitToken(request);
  if (token) {
    const digest = await hashString(token);
    return { bucketClass: "api-key", key: `k:${digest.slice(0, 32)}` };
  }

  // Anonymous /mcp gets its own bucket. It is checked AFTER the credential
  // check on purpose: an authenticated MCP caller is an api-key caller, and
  // giving them the anonymous MCP ceiling would be a downgrade for presenting
  // a token.
  if (isMcpPath(new URL(request.url).pathname)) {
    return { bucketClass: "mcp-anon", key: `m:${clientIp(request)}` };
  }

  return { bucketClass: "api-anon", key: `a:${clientIp(request)}` };
}

/**
 * Is this the MCP surface?
 *
 * Exact "/mcp" or anything beneath it — the SDK's streamable transport uses the
 * bare path and clients sometimes append a segment, and both are mounted. A
 * bare prefix test would also match "/mcpanything", which is why this is not
 * `startsWith("/mcp")`.
 *
 * @param {string} pathname
 */
export function isMcpPath(pathname) {
  return pathname === "/mcp" || pathname.startsWith("/mcp/");
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
  //
  // This IS instrumented (bypass_class "crawler") because the crawler check
  // trusts a spoofable user-agent when Bot Management is absent — if that
  // exemption ever becomes a large share of traffic, that is the signal.
  if (isVerifiedCrawler(request, env)) {
    recordRateLimitDecision(request, env, {
      decision: "allowed",
      surface,
      bucketClass: "",
      bypassClass: "crawler",
      path,
    });
    return null;
  }

  // Trusted E2E/load tests skip everything, exactly as they skip the zone rule.
  // First-party SSR does NOT skip outright any more — it gets its own runaway
  // bucket (see resolveEdgeRateLimitKey), which is what makes it safe to turn
  // enforcement on at all. That is true whether or not its secret verified:
  // `ssr-unverified` shares the bucket and differs only in the event it emits.
  const bypass = resolveRateLimitBypass(request, env);
  if (bypass === "testing") {
    recordRateLimitDecision(request, env, {
      decision: "allowed",
      surface,
      bucketClass: "",
      bypassClass: "testing",
      path,
    });
    return null;
  }

  try {
    const { bucketClass, key } = await resolveEdgeRateLimitKey(request, env, surface, bypass);
    const limits = resolveBucketLimits(bucketClass, env);
    if (!limits) return null;

    const { spec, burstLimit, sustainedLimit } = limits;
    const observed = {
      surface,
      bucketClass,
      bypassClass: bypass,
      path,
      burstLimit,
      sustainedLimit,
    };

    // Burst (10s) first: it catches a hammering client within a second or two,
    // and its 429 carries the shorter, more accurate Retry-After.
    const burst = env[spec.burstBinding];
    if (burst && typeof burst.limit === "function") {
      const outcome = await burst.limit({ key });
      if (outcome && outcome.success === false) {
        recordRateLimitDecision(request, env, {
          ...observed,
          decision: "limited",
          window: "10s",
          limit: burstLimit,
        });
        return buildRateLimitResponse(path, burstLimit, RATE_LIMIT_BURST_PERIOD_SECONDS, bucketClass);
      }
    }

    // Sustained (60s): catches the slow grind that never trips a 10s window.
    // Some classes (first-party) have no sustained bucket by design.
    if (!spec.sustainedBinding) {
      recordRateLimitDecision(request, env, { ...observed, decision: "allowed" });
      return null;
    }
    const sustained = env[spec.sustainedBinding];
    if (sustained && typeof sustained.limit === "function") {
      const outcome = await sustained.limit({ key });
      if (outcome && outcome.success === false) {
        recordRateLimitDecision(request, env, {
          ...observed,
          decision: "limited",
          window: "60s",
          limit: sustainedLimit,
        });
        return buildRateLimitResponse(
          path,
          sustainedLimit,
          RATE_LIMIT_SUSTAINED_PERIOD_SECONDS,
          bucketClass
        );
      }
    }

    recordRateLimitDecision(request, env, { ...observed, decision: "allowed" });
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

// ---------------------------------------------------------------------------
// Edge rate limit observability
//
// The enforcement layer above is otherwise invisible: the Cloudflare rate
// limiting bindings expose no analytics of their own, and a 429 leaves no trace
// beyond the response itself. These events are the only way to answer "how many
// 429s, in which bucket, for which RPC" without tailing the worker live.
//
// THE SAMPLING RULE IS DELIBERATELY ASYMMETRIC:
//
//   LIMITED decisions are emitted at 100%, ALWAYS, with no sampling.
//     A 429 is rare and high-signal. At the existing 1% analytics sample rate
//     you would see roughly one in a hundred of them, which for a bucket that
//     fires a dozen times a day means you see nothing at all and conclude the
//     limiter is idle. Under-counting the rare event is the failure mode that
//     makes rate limit observability useless, so it is ruled out structurally.
//
//   ALLOWED decisions ARE sampled (EDGE_RATE_LIMIT_SAMPLE_RATE, falling back to
//     EDGE_ANALYTICS_SAMPLE_RATE, default 0.01).
//     These are every eligible request on the zone — emitting them all would be
//     an enormous, mostly redundant log/Analytics-Engine bill for a denominator.
//
// Because the two arms carry different rates, EVERY event carries the
// `sample_rate` that produced it. Any ratio query (limited vs allowed) MUST
// divide each side by its own sample_rate before comparing, or the allowed side
// is under-counted 100x. See docs/observability/cost-attribution.md.
//
// PRIVACY: no field here may carry a credential or a client IP. The rate limit
// KEY (a token hash, a session hash, or a raw IP) is NEVER emitted in any form
// — not hashed, not truncated. Only `key_type` is emitted, which says which
// KIND of identity keyed the bucket ("token-hash" | "ip" | "session-hash") and
// nothing about who it was. Bypass SECRETS are never emitted either; only the
// class name that matched. Paths go through normalizeAnalyticsPath so a raw URL
// (and its query string) can never leak in, matching the edge_request contract.
// ---------------------------------------------------------------------------

/** Which KIND of identity keys this bucket. Never the identity itself. */
const RATE_LIMIT_KEY_TYPES = {
  "api-key": "token-hash",
  "api-anon": "ip",
  "first-party": "ip",
  "browser-anon": "ip",
  "browser-auth": "session-hash",
};

/**
 * Build the `edge_rate_limit` event.
 *
 * Pure and side-effect free so tests can assert the exact shape, and so the
 * emitting path (which must never throw) has nothing to do but stringify.
 *
 * @param {Request} request
 * @param {object} options
 * @param {"limited"|"allowed"} options.decision
 * @param {"browser"|"api"} options.surface
 * @param {string} options.bucketClass "" when no bucket was consulted
 * @param {string} [options.bypassClass] "" | "testing" | "ssr" | "ssr-unverified" | "crawler"
 * @param {string} options.path raw pathname; normalized before it is emitted
 * @param {"10s"|"60s"|""} [options.window] which window tripped; "" when allowed
 * @param {number} [options.limit] the tripped limit; 0 when allowed
 * @param {number} [options.burstLimit]
 * @param {number} [options.sustainedLimit]
 * @param {number} [options.sampleRate] the rate that produced this event
 */
export function buildRateLimitEvent(request, options) {
  const path = options.path || "/";
  const rpc = parseRpcPath(path);
  const cf = (request && request.cf) || {};
  const bucketClass = options.bucketClass || "";

  return {
    type: "edge_rate_limit",
    decision: options.decision,
    bucket_class: bucketClass,
    surface: options.surface || "",
    // "" for an allowed decision: no window tripped.
    window: options.decision === "limited" ? options.window || "" : "",
    limit: options.decision === "limited" ? options.limit || 0 : 0,
    burst_limit: options.burstLimit || 0,
    sustained_limit: options.sustainedLimit || 0,
    // Normalized, never raw — same cardinality contract as edge_request.path.
    path: normalizeAnalyticsPath(path),
    route_group: normalizeRouteGroup(hostFromRequest(request), path),
    api_family: rpc.api_family,
    rpc_method: rpc.rpc_method,
    method: (request && request.method) || "",
    // The KIND of key, never the key. "" when no bucket was consulted.
    key_type: RATE_LIMIT_KEY_TYPES[bucketClass] || "",
    bypass_class: options.bypassClass || "",
    cf_colo: typeof cf.colo === "string" ? cf.colo : "",
    cf_ray: (request && request.headers && request.headers.get("cf-ray")) || "",
    // Always present: a ratio query is wrong without it (see block comment).
    sample_rate: Number.isFinite(options.sampleRate) ? options.sampleRate : 1,
  };
}

function hostFromRequest(request) {
  try {
    return new URL(request.url).hostname;
  } catch (_) {
    return "";
  }
}

/**
 * The sample rate for ALLOWED decisions. Limited decisions never consult this.
 *
 * `EDGE_RATE_LIMIT_SAMPLE_RATE` lets the denominator be tuned independently of
 * the general edge_request stream; when unset it inherits
 * `EDGE_ANALYTICS_SAMPLE_RATE` so there is one number to change by default.
 *
 * @param {Record<string, any>} env
 */
export function resolveRateLimitSampleRate(env = {}) {
  const explicit = env.EDGE_RATE_LIMIT_SAMPLE_RATE;
  if (explicit !== undefined && explicit !== null && String(explicit).trim() !== "") {
    return clampSampleRate(parseFloat(explicit));
  }
  return clampSampleRate(parseFloat(env.EDGE_ANALYTICS_SAMPLE_RATE || "0.01"));
}

/**
 * Emit an `edge_rate_limit` event.
 *
 * TOTALLY BEST-EFFORT. Every branch is inside a try/catch and the function
 * returns void — instrumentation must never be the reason a request fails, and
 * `enforceEdgeRateLimit` itself already fails open. Callers do not await it.
 *
 * @param {Request} request
 * @param {Record<string, any>} env
 * @param {object} options see buildRateLimitEvent
 * @returns {void}
 */
export function recordRateLimitDecision(request, env, options) {
  try {
    const limited = options.decision === "limited";

    // THE ASYMMETRY: limited is unconditional, allowed is sampled.
    const sampleRate = limited ? 1 : resolveRateLimitSampleRate(env);
    if (!limited && (sampleRate <= 0 || Math.random() > sampleRate)) return;

    const event = buildRateLimitEvent(request, { ...options, sampleRate });

    console.log(JSON.stringify(event));
    writeRateLimitDataPoint(env, event);
  } catch (_) {
    // Observability must never affect request handling.
  }
}

/**
 * OPTIONAL Cloudflare Workers Analytics Engine write.
 *
 * WHY: "how many 429s by bucket_class over the last 7 days" is a time-series
 * aggregate, and grepping sampled JSON console lines is the wrong tool for it.
 * Analytics Engine gives that query a SQL endpoint with no log pipeline to run.
 * It is available on this account (Workers Paid subscription confirmed) but the
 * binding is ABSENT BY DEFAULT — Terraform only attaches it when
 * `edge_rate_limit_analytics_dataset` is set to a non-empty dataset name.
 *
 * Everything here is defensive: an unbound name, a binding without
 * writeDataPoint, or a throwing write are all no-ops. The console.log event
 * above is the source of truth and does not depend on this.
 *
 * SCHEMA (fixed positions — the SQL in docs/observability/cost-attribution.md
 * refers to blob1..blob11 / double1..double4 by position, so entries may be
 * APPENDED but never reordered or removed):
 *
 *   index1  bucket_class      (AE samples by index; the primary group-by)
 *   blob1   decision          blob7   api_family
 *   blob2   bucket_class      blob8   rpc_method
 *   blob3   surface           blob9   path
 *   blob4   window            blob10  method
 *   blob5   key_type          blob11  cf_colo
 *   blob6   bypass_class
 *   double1 limit             double3 sustained_limit
 *   double2 burst_limit       double4 sample_rate
 *
 * @param {Record<string, any>} env
 * @param {object} event the already-built edge_rate_limit event
 */
function writeRateLimitDataPoint(env, event) {
  const dataset = env && env.RATE_LIMIT_ANALYTICS;
  if (!dataset || typeof dataset.writeDataPoint !== "function") return;

  try {
    dataset.writeDataPoint({
      // One index, max 96 bytes. bucket_class is the dimension every query
      // groups by and has exactly six values, so it is the right index.
      indexes: [event.bucket_class || "none"],
      blobs: [
        event.decision,
        event.bucket_class,
        event.surface,
        event.window,
        event.key_type,
        event.bypass_class,
        event.api_family,
        event.rpc_method,
        event.path,
        event.method,
        event.cf_colo,
      ],
      doubles: [event.limit, event.burst_limit, event.sustained_limit, event.sample_rate],
    });
  } catch (_) {
    // Analytics Engine is a nice-to-have; the JSON line already landed.
  }
}

// ---------------------------------------------------------------------------
// Edge event stream — origin health, upstream latency, config, bypass, KV
//
// The `edge_request` stream answers "how much traffic, and did it cache".
// `edge_rate_limit` answers "who did we reject". Everything in this section
// exists because a specific operational question was, until now, UNANSWERABLE
// without live-tailing the worker:
//
//   edge_origin_error      an origin outage is currently invisible at the edge.
//                          It surfaces only as user-facing errors, and the
//                          sampled edge_request stream shows ~1% of them.
//   edge_upstream_latency  "which RPCs are slow, and is the cache helping"
//                          needs a low-cardinality bucketed dimension, not a
//                          raw millisecond column.
//   edge_config            "did the config I just deployed actually land" today
//                          requires reading Terraform state or the CF API.
//   edge_bypass_used       a bypass that short-circuits before any bucket emits
//                          nothing at all. A leaked E2E secret is silent.
//   edge_kv_error          KV failures are swallowed in four places. A KV
//                          outage silently converts every request into an
//                          origin fetch — a cost and latency event with no log.
//   edge_cache_purge       a failed purge means stale data for up to 24h, and
//                          the only record of it is the HTTP response nobody
//                          reads.
//
// THREE RULES APPLY TO EVERY EMITTER HERE, and are covered by tests:
//
//   1. NOTHING THROWS INTO THE REQUEST PATH. Every emitter is a void function
//      whose entire body is inside a try/catch. Callers never await them.
//   2. NO RAW ANYTHING. No raw paths (normalizeAnalyticsPath only), no query
//      strings, no credentials, no IPs, no secrets, and — importantly for the
//      error events — NO RAW ERROR MESSAGES. An exception message can contain a
//      URL with a token in it, so errors are classified into a bounded
//      vocabulary and the message is discarded.
//   3. RARE-AND-ACTIONABLE IS 100%, ROUTINE IS SAMPLED. Sampling a rare event
//      at 1% means never seeing it, which is the failure mode that makes
//      observability decorative. Sampling knobs mirror the existing ones: a
//      dedicated `EDGE_*_SAMPLE_RATE` var that inherits
//      `EDGE_ANALYTICS_SAMPLE_RATE` when blank.
// ---------------------------------------------------------------------------

/** Latency buckets. Bucketed so this can be a GROUP BY dimension forever. */
const UPSTREAM_LATENCY_BUCKETS = [
  { max: 50, label: "<50ms" },
  { max: 200, label: "50-200ms" },
  { max: 500, label: "200-500ms" },
  { max: 1000, label: "500-1000ms" },
  { max: 3000, label: "1000-3000ms" },
];

/**
 * Bucket a duration. Never emit raw milliseconds as a dimension — a
 * `GROUP BY duration_ms` has as many groups as there are requests.
 * @param {number} ms
 */
export function bucketDuration(ms) {
  const value = Number.isFinite(ms) && ms >= 0 ? ms : 0;
  for (const bucket of UPSTREAM_LATENCY_BUCKETS) {
    if (value < bucket.max) return bucket.label;
  }
  return "3000ms+";
}

/**
 * Bounded status class. `status` itself is a number (a fine metric column),
 * but the dimension every query groups by must be one of five values.
 * @param {number} status 0 when the fetch threw before producing a response
 */
export function statusClass(status) {
  if (!Number.isFinite(status) || status <= 0) return "error";
  if (status < 200) return "1xx";
  if (status < 300) return "2xx";
  if (status < 400) return "3xx";
  if (status < 500) return "4xx";
  return "5xx";
}

/**
 * Is this origin response a failure worth an `edge_origin_error`?
 *
 * 5xx and 3xx and 1xx qualify; 4xx does NOT. A 404/401/429 from the origin is
 * the origin working correctly and telling a caller something — emitting it
 * here would bury the rare, actionable signal (the origin is broken) under a
 * routine one (a client sent a bad request). 3xx qualifies because none of
 * these origins should ever redirect: a redirect from Cloud Run means a
 * misrouted request or a changed service URL, which is a deploy fault.
 *
 * The ONE exception is the `frontend` origin: Vercel legitimately redirects
 * (trailing slashes, i18n, auth), so a 3xx there is normal traffic, not a
 * fault, and counting it would drown the signal.
 *
 * @param {number} status
 * @param {string} [origin] bounded origin name
 */
export function isOriginFailureStatus(status, origin = "") {
  const cls = statusClass(status);
  if (cls === "3xx") return origin !== "frontend";
  return cls === "5xx" || cls === "1xx" || cls === "error";
}

/**
 * Classify a thrown fetch error into a BOUNDED vocabulary.
 *
 * The raw message is deliberately discarded and never emitted. Workers surface
 * origin failures as opaque `TypeError`s whose message sometimes embeds the
 * request URL — and that URL can carry a query string. A bounded class is both
 * safer and more useful as a dimension.
 *
 * @param {unknown} err
 * @returns {"timeout"|"aborted"|"network"|"internal"}
 */
export function classifyFetchError(err) {
  const name = (err && typeof err === "object" && typeof err.name === "string" ? err.name : "").toLowerCase();
  let message = "";
  try {
    message = String((err && err.message) || "").toLowerCase();
  } catch (_) {
    message = "";
  }

  if (name === "aborterror") return "aborted";
  if (name === "timeouterror" || message.includes("timed out") || message.includes("timeout")) {
    return "timeout";
  }
  if (
    message.includes("network") ||
    message.includes("connection") ||
    message.includes("socket") ||
    message.includes("dns") ||
    message.includes("tcp") ||
    message.includes("tls") ||
    message.includes("unreachable")
  ) {
    return "network";
  }
  return "internal";
}

/**
 * Map an origin base URL back to a BOUNDED origin name.
 *
 * The raw origin URL is never emitted as a dimension — it would be a
 * per-revision Cloud Run hostname, which changes on every deploy and would
 * fragment every group-by. Five names cover every origin this worker talks to.
 *
 * @param {Record<string, any>} env
 * @param {string} originBase
 * @returns {"shorts"|"market-data"|"chat"|"frontend"|"other"|"unknown"}
 */
export function resolveOriginName(env, originBase) {
  if (!originBase) return "unknown";
  const e = env || {};
  if (originBase === e.SHORTS_API_ORIGIN) return "shorts";
  if (originBase === e.MARKET_DATA_ORIGIN) return "market-data";
  if (originBase === e.CHAT_SERVICE_ORIGIN) return "chat";
  if (originBase === FRONTEND_ORIGIN) return "frontend";
  return "other";
}

/**
 * The normalized request dimensions every event in this section shares.
 * Tolerates a malformed/absent request — instrumentation must never throw.
 *
 * @param {Request | null} request
 * @param {string} path
 */
function eventContext(request, path) {
  const safePath = typeof path === "string" && path ? path : "/";
  const rpc = parseRpcPath(safePath);
  let host = "";
  try {
    host = new URL(request.url).hostname;
  } catch (_) {
    host = "";
  }
  let cfRay = "";
  try {
    cfRay = (request && request.headers && request.headers.get("cf-ray")) || "";
  } catch (_) {
    cfRay = "";
  }
  const cf = (request && request.cf) || {};

  return {
    path: normalizeAnalyticsPath(safePath),
    route_group: normalizeRouteGroup(host, safePath),
    api_family: rpc.api_family,
    rpc_method: rpc.rpc_method,
    method: (request && request.method) || "",
    cf_colo: typeof cf.colo === "string" ? cf.colo : "",
    cf_ray: cfRay,
  };
}

/** The one place an event line is written. Never throws. */
function emitEdgeEvent(event) {
  try {
    console.log(JSON.stringify(event));
  } catch (_) {
    // Logging is best-effort by construction.
  }
}

/**
 * A named sample rate that inherits `EDGE_ANALYTICS_SAMPLE_RATE` when blank.
 *
 * Same contract as `resolveRateLimitSampleRate`: Terraform emits `""` for its
 * -1 "inherit" sentinel, so blank must fall back rather than parse to NaN.
 *
 * @param {Record<string, any>} env
 * @param {string} name e.g. "EDGE_UPSTREAM_LATENCY_SAMPLE_RATE"
 */
export function resolveNamedSampleRate(env, name) {
  const e = env || {};
  const explicit = e[name];
  if (explicit !== undefined && explicit !== null && String(explicit).trim() !== "") {
    return clampSampleRate(parseFloat(explicit));
  }
  return clampSampleRate(parseFloat(e.EDGE_ANALYTICS_SAMPLE_RATE || "0.01"));
}

// --- edge_origin_error -----------------------------------------------------

/**
 * Build the `edge_origin_error` event. Pure, so tests can pin the shape.
 *
 * @param {Request | null} request
 * @param {object} options
 * @param {string} options.origin bounded origin name
 * @param {number} options.status 0 when the fetch threw
 * @param {string} [options.errorClass] "" for an HTTP status failure
 * @param {string} options.path raw pathname; normalized before emission
 * @param {number} options.durationMs
 * @param {boolean} [options.servedStale]
 * @param {boolean} [options.retried]
 */
export function buildOriginErrorEvent(request, options) {
  const ctx = eventContext(request, options.path);
  const status = Number.isFinite(options.status) ? options.status : 0;

  return {
    type: "edge_origin_error",
    origin: options.origin || "unknown",
    status,
    status_class: statusClass(status),
    // "" when the origin answered with a status; a bounded class when it threw.
    error_class: options.errorClass || "",
    ...ctx,
    duration_ms: Math.max(0, Math.round(options.durationMs || 0)),
    // Did a cache tier absorb this for the user? See the doc note: the worker
    // has no stale-on-error fallback today, so this is always false — which is
    // the accurate statement that the user ate the error.
    served_stale: Boolean(options.servedStale),
    // True on the second attempt of the transparent retry in proxyWithHeaders /
    // proxyFrontend. Two events for one client request means both attempts
    // failed and the client definitely saw an error.
    retried: Boolean(options.retried),
    // NEVER sampled. An origin outage is rare and always actionable; seeing 1%
    // of it is indistinguishable from seeing none of it.
    sample_rate: 1,
  };
}

/**
 * Emit an `edge_origin_error`. Always 100%. Never throws, returns void.
 *
 * @param {Request | null} request
 * @param {Record<string, any>} env
 * @param {object} options see buildOriginErrorEvent
 * @returns {void}
 */
export function recordOriginError(request, env, options) {
  try {
    const event = buildOriginErrorEvent(request, options);
    emitEdgeEvent(event);
    writeEdgeEventDataPoint(env, event);
  } catch (_) {
    // Observability must never affect request handling.
  }
}

/**
 * Fetch an origin with failure instrumentation.
 *
 * Transparent: returns exactly what `fetch` returns and rethrows exactly what
 * `fetch` throws, so every existing caller's control flow (including the
 * retry-on-throw fallbacks) is unchanged. The only addition is that a failure
 * now leaves a trace.
 *
 * @param {Record<string, any>} env
 * @param {Request | null} request the CLIENT request, for dimensions
 * @param {string} originUrl the fully built origin URL
 * @param {RequestInit} init
 * @param {{originBase?: string, path?: string, retried?: boolean}} meta
 */
async function fetchOrigin(env, request, originUrl, init, meta = {}) {
  const origin = resolveOriginName(env, meta.originBase);
  const started = Date.now();

  try {
    const response = await fetch(originUrl, init);
    if (isOriginFailureStatus(response.status, origin)) {
      recordOriginError(request, env, {
        origin,
        status: response.status,
        path: meta.path,
        durationMs: Date.now() - started,
        retried: meta.retried,
      });
    }
    return response;
  } catch (err) {
    recordOriginError(request, env, {
      origin,
      status: 0,
      errorClass: classifyFetchError(err),
      path: meta.path,
      durationMs: Date.now() - started,
      retried: meta.retried,
    });
    throw err;
  }
}

// --- edge_upstream_latency -------------------------------------------------

/**
 * Build the `edge_upstream_latency` event.
 *
 * WHY THIS IS NOT REDUNDANT WITH `edge_request.duration_ms`. It is the same
 * measurement, deliberately: what differs is that it is BUCKETED and therefore
 * usable as a group-by dimension in Analytics Engine, which has no percentile
 * functions and no cheap way to aggregate a raw millisecond column. That makes
 * "which RPCs are slow, and does caching help" answerable with NO log pipeline
 * — the thing this account does not have (there is no Logpush job). It also
 * carries its own sample rate, so latency can be sampled far more heavily than
 * the full request stream without multiplying the cost of everything else.
 *
 * `cache_status` is the load-bearing field: comparing the bucket distribution
 * for HIT/HOT/KV against MISS for the same `rpc_method` IS the "is the cache
 * earning its keep" answer.
 *
 * @param {Request} request
 * @param {Response} response
 * @param {object} options
 */
export function buildUpstreamLatencyEvent(request, response, options) {
  let path = "/";
  try {
    path = new URL(request.url).pathname;
  } catch (_) {
    path = "/";
  }
  const ctx = eventContext(request, path);
  const status = (response && response.status) || 0;
  let cacheStatus = "UNKNOWN";
  try {
    cacheStatus = (response && response.headers.get("X-Shorted-Cache")) || "UNKNOWN";
  } catch (_) {
    cacheStatus = "UNKNOWN";
  }
  const durationMs = Math.max(0, (options.now || 0) - (options.started || 0));

  return {
    type: "edge_upstream_latency",
    origin: options.origin || "unknown",
    cache_status: cacheStatus,
    // Bucketed, never raw: this is a dimension.
    duration_bucket: bucketDuration(durationMs),
    // `status` is a VALUE (fine to average/filter on); `status_class` is the
    // DIMENSION. Never group by the former.
    status,
    status_class: statusClass(status),
    ...ctx,
    cache_ttl_seconds: options.cacheTtl || 0,
    sample_rate: options.sampleRate,
  };
}

/**
 * Emit an `edge_upstream_latency` event, sampled. Never throws.
 *
 * @param {Request} request
 * @param {Record<string, any>} env
 * @param {Response} response
 * @param {string} origin
 * @param {number} cacheTtl
 * @param {number} started
 * @returns {void}
 */
export function recordUpstreamLatency(request, env, response, origin, cacheTtl, started) {
  try {
    const sampleRate = resolveNamedSampleRate(env, "EDGE_UPSTREAM_LATENCY_SAMPLE_RATE");
    if (sampleRate <= 0 || Math.random() > sampleRate) return;

    const event = buildUpstreamLatencyEvent(request, response, {
      origin,
      cacheTtl,
      started,
      now: Date.now(),
      sampleRate,
    });
    emitEdgeEvent(event);
    writeEdgeEventDataPoint(env, event);
  } catch (_) {
    // Observability must never affect request handling.
  }
}

// --- edge_config -----------------------------------------------------------

/**
 * Once-per-ISOLATE, not once-per-request. A Cloudflare isolate serves many
 * requests; this fires on the first one it handles and never again for the
 * life of that isolate. Isolates are recycled often enough (deploys, colo
 * churn, eviction) that a fresh snapshot lands within minutes of any deploy,
 * everywhere, without adding a per-request cost.
 */
let edgeConfigEmitted = false;

/** Test-only: reset per-isolate module state. */
export function __resetEdgeEventStateForTests() {
  edgeConfigEmitted = false;
  kvErrorWindowStart = 0;
  kvErrorWindowCount = 0;
  kvErrorSuppressed = 0;
}

function bindingBound(env, name) {
  const binding = env && env[name];
  return Boolean(binding && typeof binding.limit === "function");
}

function originHost(value) {
  if (!value) return "";
  try {
    return new URL(value).hostname;
  } catch (_) {
    return "";
  }
}

/**
 * Build the `edge_config` event: what the worker BELIEVES is configured.
 *
 * This is the deploy feedback loop. Terraform state says what was *intended*;
 * the Cloudflare API says what is *stored*; this says what the code running in
 * an isolate right now actually *reads*. Those three have diverged before.
 *
 * ONLY BOOLEANS FOR SECRETS. `*_secret_present` says whether a non-empty secret
 * is bound. The value itself is never read into an event, never hashed into
 * one, and never length-reported (a length is a real hint). A test greps
 * serialized events for the actual secret values.
 *
 * @param {Record<string, any>} env
 * @param {Request | null} request
 */
export function buildEdgeConfigEvent(env, request) {
  const e = env || {};
  const cf = (request && request.cf) || {};

  /** @type {Record<string, object>} */
  const buckets = {};
  for (const [bucketClass, spec] of Object.entries(RATE_LIMIT_BUCKETS)) {
    const limits = resolveBucketLimits(bucketClass, e);
    buckets[bucketClass] = {
      burst_limit: limits ? limits.burstLimit : 0,
      sustained_limit: limits ? limits.sustainedLimit : 0,
      // The killer field: `rate_limit_enabled: true` with an unbound binding
      // means enforcement is silently doing nothing at all.
      burst_bound: bindingBound(e, spec.burstBinding),
      sustained_bound: spec.sustainedBinding ? bindingBound(e, spec.sustainedBinding) : false,
    };
  }

  return {
    type: "edge_config",
    // Set by Terraform to a short hash of the deployed worker.js. This is what
    // closes the loop: compare it to the hash of the file you just merged.
    deploy_id: typeof e.EDGE_DEPLOY_ID === "string" ? e.EDGE_DEPLOY_ID : "",
    cf_colo: typeof cf.colo === "string" ? cf.colo : "",
    rate_limit_enabled: e.EDGE_RATE_LIMIT_ENABLED === "true",
    trust_crawler_ua: e.EDGE_RATE_LIMIT_TRUST_CRAWLER_UA !== "false",
    buckets,
    sample_rates: {
      edge_request: clampSampleRate(parseFloat(e.EDGE_ANALYTICS_SAMPLE_RATE || "0.01")),
      rate_limit_allowed: resolveRateLimitSampleRate(e),
      upstream_latency: resolveNamedSampleRate(e, "EDGE_UPSTREAM_LATENCY_SAMPLE_RATE"),
      bypass_routine: resolveNamedSampleRate(e, "EDGE_BYPASS_SAMPLE_RATE"),
    },
    // BOOLEANS ONLY. Never the values, never their lengths.
    secrets_present: {
      testing_bypass: Boolean(e.RATE_LIMIT_TESTING_BYPASS_SECRET),
      ssr_bypass: Boolean(e.RATE_LIMIT_SSR_BYPASS_SECRET),
      cache_purge: Boolean(e.CACHE_PURGE_SECRET),
    },
    // The bypass MARKERS are not secrets — they are user-agent substrings and
    // header names, and knowing which one is configured is the whole point.
    bypass_markers: {
      testing_user_agent: e.RATE_LIMIT_TESTING_BYPASS_USER_AGENT || "Shorted-E2E",
      testing_header: e.RATE_LIMIT_TESTING_BYPASS_HEADER_NAME || "x-shorted-testing-bypass",
      ssr_user_agent: e.RATE_LIMIT_SSR_BYPASS_USER_AGENT || "shorted-web-ssr",
      ssr_header: e.RATE_LIMIT_SSR_BYPASS_HEADER_NAME || "x-shorted-ssr-bypass",
    },
    bindings: {
      edge_kv: Boolean(e.EDGE_KV && typeof e.EDGE_KV.get === "function"),
      rate_limit_analytics: Boolean(
        e.RATE_LIMIT_ANALYTICS && typeof e.RATE_LIMIT_ANALYTICS.writeDataPoint === "function"
      ),
      edge_events_analytics: Boolean(
        e.EDGE_EVENTS_ANALYTICS && typeof e.EDGE_EVENTS_ANALYTICS.writeDataPoint === "function"
      ),
    },
    // Hostnames, not full URLs: a Cloud Run hostname is public and is exactly
    // what you check after re-pointing an origin. No paths, no query strings.
    origins: {
      shorts: originHost(e.SHORTS_API_ORIGIN),
      market_data: originHost(e.MARKET_DATA_ORIGIN),
      chat: originHost(e.CHAT_SERVICE_ORIGIN),
    },
    cache_ttl_seconds: {
      default: parseInt(e.CACHE_TTL_DEFAULT || "60", 10),
      top_shorts: parseInt(e.CACHE_TTL_TOP_SHORTS || "300", 10),
      stock_data: parseInt(e.CACHE_TTL_STOCK_DATA || "120", 10),
      news: parseInt(e.CACHE_TTL_NEWS || "300", 10),
      public_daily: parseInt(e.CACHE_TTL_PUBLIC_DAILY || "3600", 10),
      public_stale: parseInt(e.CACHE_TTL_PUBLIC_STALE || "86400", 10),
      hot_cache_ms: HOT_CACHE_TTL_MS,
    },
    sample_rate: 1,
  };
}

/**
 * Emit `edge_config` exactly once per isolate. Never throws, returns void.
 *
 * The flag is set BEFORE the event is built, so even a pathological failure
 * inside the builder cannot turn this into a per-request emitter.
 *
 * @param {Record<string, any>} env
 * @param {Request | null} request
 * @returns {void}
 */
export function recordEdgeConfigOnce(env, request) {
  if (edgeConfigEmitted) return;
  edgeConfigEmitted = true;
  try {
    emitEdgeEvent(buildEdgeConfigEvent(env, request));
  } catch (_) {
    // Observability must never affect request handling.
  }
}

// --- edge_bypass_used ------------------------------------------------------

/**
 * Resolve what a first-party bypass marker ATTEMPTED, including failures.
 *
 * `resolveRateLimitBypass` answers "did a bypass apply". This answers the
 * strictly larger question "did anything claim a bypass, and what happened",
 * which is where the security signal lives:
 *
 *   accepted     marker + correct secret. Routine for `ssr`, alarming for
 *                `testing` outside a test window (a leaked secret).
 *   rejected     marker present, secret WRONG or missing while a secret IS
 *                configured. This is someone probing, and it is the loudest
 *                thing in this file.
 *   unconfigured marker present but no secret is configured on the worker at
 *                all. Not an attack — a misconfiguration, and the exact
 *                signature of "the SSR secret did not reach Cloudflare", which
 *                is the failure that 429s real users through the Vercel
 *                rewrite path.
 *
 * @param {Request} request
 * @param {Record<string, any>} env
 * @returns {{bypassClass: ""|"testing"|"ssr", outcome: ""|"accepted"|"rejected"|"unconfigured"}}
 */
export function resolveBypassAttempt(request, env) {
  const e = env || {};
  let ua = "";
  try {
    ua = (request && request.headers && request.headers.get("user-agent")) || "";
  } catch (_) {
    ua = "";
  }

  const classes = [
    {
      bypassClass: /** @type {const} */ ("testing"),
      secret: e.RATE_LIMIT_TESTING_BYPASS_SECRET || "",
      marker: e.RATE_LIMIT_TESTING_BYPASS_USER_AGENT || "Shorted-E2E",
      header: e.RATE_LIMIT_TESTING_BYPASS_HEADER_NAME || "x-shorted-testing-bypass",
    },
    {
      bypassClass: /** @type {const} */ ("ssr"),
      secret: e.RATE_LIMIT_SSR_BYPASS_SECRET || "",
      marker: e.RATE_LIMIT_SSR_BYPASS_USER_AGENT || "shorted-web-ssr",
      header: e.RATE_LIMIT_SSR_BYPASS_HEADER_NAME || "x-shorted-ssr-bypass",
    },
  ];

  for (const candidate of classes) {
    if (!ua.includes(candidate.marker)) continue;
    if (!candidate.secret) {
      return { bypassClass: candidate.bypassClass, outcome: "unconfigured" };
    }
    let presented = "";
    try {
      presented = (request.headers.get(candidate.header) || "");
    } catch (_) {
      presented = "";
    }
    return {
      bypassClass: candidate.bypassClass,
      outcome: secretsMatch(presented, candidate.secret) ? "accepted" : "rejected",
    };
  }

  return { bypassClass: "", outcome: "" };
}

/**
 * Build the `edge_bypass_used` event.
 *
 * @param {Request} request
 * @param {object} options
 */
export function buildBypassEvent(request, options) {
  const ctx = eventContext(request, options.path);
  return {
    type: "edge_bypass_used",
    bypass_class: options.bypassClass,
    outcome: options.outcome,
    surface: options.surface || "",
    ...ctx,
    // Context that makes the event self-explanatory without a join: a bypass
    // used while enforcement is OFF, or on an ineligible path, would never have
    // produced an edge_rate_limit event at all — which is precisely the gap
    // this event closes.
    enforcement_enabled: Boolean(options.enforcementEnabled),
    eligible_path: Boolean(options.eligiblePath),
    // How many unproven-claim events the per-isolate cap dropped since the last
    // one it let through. 0 for every sampled/uncapped arm. Without it a capped
    // emitter silently understates a config error's true blast radius.
    suppressed: options.suppressed || 0,
    sample_rate: options.sampleRate,
  };
}

// An unproven first-party claim is emitted UNSAMPLED (it is the misconfiguration
// alarm) but capped: a wrong or missing secret is wrong for every request, so
// uncapped-and-unsampled would turn one config error into a logging bill the
// size of first-party traffic. Same shape as the KV-error cap below.
const UNPROVEN_BYPASS_WINDOW_MS = 60_000;
const UNPROVEN_BYPASS_MAX_PER_WINDOW = 20;
let unprovenBypassWindowStart = 0;
let unprovenBypassWindowCount = 0;
let unprovenBypassSuppressed = 0;

/**
 * Claim an emit slot for an unproven first-party bypass attempt.
 *
 * @returns {{allowed: boolean, suppressed: number}} `suppressed` is the number
 *   of attempts dropped since the previous allowed emit, and is only non-zero
 *   on an allowed one.
 */
function takeUnprovenBypassEmitSlot() {
  const now = Date.now();
  if (now - unprovenBypassWindowStart > UNPROVEN_BYPASS_WINDOW_MS) {
    unprovenBypassWindowStart = now;
    unprovenBypassWindowCount = 0;
  }
  if (unprovenBypassWindowCount >= UNPROVEN_BYPASS_MAX_PER_WINDOW) {
    unprovenBypassSuppressed += 1;
    return { allowed: false, suppressed: 0 };
  }
  unprovenBypassWindowCount += 1;
  const suppressed = unprovenBypassSuppressed;
  unprovenBypassSuppressed = 0;
  return { allowed: true, suppressed };
}

/**
 * Emit `edge_bypass_used`. Never throws, returns void.
 *
 * SAMPLING, AND WHY IT IS NOT A FLAT 100%:
 *
 *   `testing` — ALWAYS 100%, every outcome. The E2E bypass should be near-zero
 *     outside a deliberate test run, so its volume is negligible and its
 *     appearance is the alarm. This is the leaked-secret detector and no knob
 *     can sample it away.
 *   any `rejected` or `unconfigured` — ALWAYS 100%, but CAPPED per isolate per
 *     minute. Both mean "something claimed to be us and we could not confirm
 *     it": a probe, a rotated-but-not-propagated secret, or an env var that
 *     never reached a deployment. That condition is now BENIGN for traffic
 *     (unverified first-party gets the generous bucket, see
 *     resolveRateLimitBypass) which is exactly why it MUST NOT be quiet — the
 *     August 2026 incident was invisible for days because the only symptom was
 *     429s nobody was querying for. Sampling it at 1% would reproduce that.
 *     The cap exists because a secret that is wrong is wrong for EVERY request:
 *     unsampled-and-uncapped would turn a config error into a logging bill.
 *     `suppressed` reports what the cap dropped, so volume is never understated.
 *   `ssr` accepted — SAMPLED (`EDGE_BYPASS_SAMPLE_RATE`, inherits
 *     `EDGE_ANALYTICS_SAMPLE_RATE`). This arm is EVERY first-party request the
 *     Vercel rewrites proxy — the steady state, and the single highest-volume
 *     class on the API host. Emitting it at 100% would mean logging 100% of
 *     first-party traffic to observe a condition that is true by design. The
 *     `sample_rate` field is on every event, so an "is the SSR marker landing"
 *     volume query corrects for it exactly (see the docs).
 *
 * @param {Request} request
 * @param {Record<string, any>} env
 * @param {string} path
 * @param {string} hostname
 * @returns {void}
 */
export function recordBypassUsage(request, env, path, hostname) {
  try {
    const { bypassClass, outcome } = resolveBypassAttempt(request, env);
    if (!bypassClass) return;

    const unproven = outcome === "rejected" || outcome === "unconfigured";
    const alwaysEmit = bypassClass === "testing" || unproven;
    let suppressed = 0;
    if (unproven) {
      const slot = takeUnprovenBypassEmitSlot();
      if (!slot.allowed) return;
      suppressed = slot.suppressed;
    }
    const sampleRate = alwaysEmit ? 1 : resolveNamedSampleRate(env, "EDGE_BYPASS_SAMPLE_RATE");
    if (!alwaysEmit && (sampleRate <= 0 || Math.random() > sampleRate)) return;

    const surface = resolveRateLimitSurface(hostname);
    emitEdgeEvent(
      buildBypassEvent(request, {
        bypassClass,
        outcome,
        surface,
        path,
        enforcementEnabled: (env || {}).EDGE_RATE_LIMIT_ENABLED === "true",
        eligiblePath: isRateLimitEligiblePath(surface, path),
        sampleRate,
        suppressed,
      })
    );
  } catch (_) {
    // Observability must never affect request handling.
  }
}

// --- edge_kv_error ---------------------------------------------------------

// A KV outage is not one failure, it is every request failing. At 100% with no
// cap, a dead KV namespace turns this emitter into the outage. The cap keeps
// the signal (you learn KV is broken within one request) while bounding the
// cost (at most 20 lines per isolate per minute), and `suppressed` reports
// exactly how much was dropped so the volume is never silently understated.
const KV_ERROR_WINDOW_MS = 60_000;
const KV_ERROR_MAX_PER_WINDOW = 20;
let kvErrorWindowStart = 0;
let kvErrorWindowCount = 0;
let kvErrorSuppressed = 0;

/**
 * Emit an `edge_kv_error`. Rate-capped per isolate. Never throws.
 *
 * WHY THIS EXISTS: KV failures are swallowed in four places in this file
 * (`getCacheVersion`, the KV read, the cache-aside write, the purge write) and
 * every one of those catches is correct — a KV fault must not fail a request.
 * But the consequence is that a KV outage is INVISIBLE while it silently
 * converts every cacheable request into an origin fetch. That is a latency and
 * a Cloud Run bill event with, until now, no log line anywhere.
 *
 * @param {Record<string, any>} env
 * @param {Request | null} request
 * @param {object} options
 * @param {"get"|"put"|"version-get"|"version-put"} options.op
 * @param {"prewarm"|"control"} options.keyKind bounded — never the key itself
 * @param {unknown} options.error
 * @param {string} [options.path]
 * @returns {void}
 */
export function recordKvError(env, request, options) {
  try {
    const now = Date.now();
    if (now - kvErrorWindowStart > KV_ERROR_WINDOW_MS) {
      kvErrorWindowStart = now;
      kvErrorWindowCount = 0;
    }
    if (kvErrorWindowCount >= KV_ERROR_MAX_PER_WINDOW) {
      kvErrorSuppressed++;
      return;
    }
    kvErrorWindowCount++;
    const suppressed = kvErrorSuppressed;
    kvErrorSuppressed = 0;

    emitEdgeEvent({
      type: "edge_kv_error",
      op: options.op,
      // Which KEY SPACE failed, never the key. `prewarm` is the cached-response
      // space; `control` is the cache-version pointer, whose failure means a
      // purge cannot take effect at all.
      key_kind: options.keyKind,
      error_class: classifyFetchError(options.error),
      ...eventContext(request, options.path),
      // Events dropped by the cap since the last emitted one. Non-zero means
      // KV is failing faster than this is reporting.
      suppressed,
      sample_rate: 1,
    });
  } catch (_) {
    // Observability must never affect request handling.
  }
}

// --- edge_cache_purge ------------------------------------------------------

/**
 * Emit an `edge_cache_purge`. Always 100% — a purge happens a handful of times
 * a day (deploys, revalidation sweeps), so volume is a non-issue, and a FAILED
 * purge means stale data is served for up to the full 24h KV TTL with no other
 * record than an HTTP response body nobody reads.
 *
 * `unauthorized` is included deliberately: the purge endpoint takes a shared
 * secret in the request body, so repeated unauthorized attempts are someone
 * probing for it.
 *
 * @param {Record<string, any>} env
 * @param {Request | null} request
 * @param {object} options
 * @param {"purged"|"failed"|"unauthorized"} options.outcome
 * @param {string} [options.reason] bounded reason code, never a raw message
 * @param {number} [options.hotEntriesCleared]
 * @param {number} [options.durationMs]
 * @returns {void}
 */
export function recordCachePurge(env, request, options) {
  try {
    emitEdgeEvent({
      type: "edge_cache_purge",
      outcome: options.outcome,
      // Bounded vocabulary: "", "kv-unbound", "kv-write-failed", "bad-secret".
      // The purge body IS the secret, so nothing from the request is echoed.
      reason: options.reason || "",
      hot_entries_cleared: Number.isFinite(options.hotEntriesCleared)
        ? options.hotEntriesCleared
        : 0,
      duration_ms: Math.max(0, Math.round(options.durationMs || 0)),
      ...eventContext(request, "/api/cache/purge"),
      sample_rate: 1,
    });
  } catch (_) {
    // Observability must never affect request handling.
  }
}

// --- Optional Analytics Engine for the origin/latency streams --------------

/**
 * OPTIONAL Analytics Engine write for `edge_origin_error` and
 * `edge_upstream_latency`.
 *
 * WHY A SECOND DATASET. `RATE_LIMIT_ANALYTICS` has a positional schema pinned
 * to rate limit fields, and Analytics Engine columns are positional per
 * dataset. Two events with different shapes cannot share it without one of them
 * writing nonsense into the other's columns. These two events DO share a shape
 * (an origin, an outcome class, an RPC, a duration), so they share one dataset
 * keyed by `blob1` / `index1`.
 *
 * Absent binding, missing `writeDataPoint`, or a throwing write are all no-ops.
 * The JSON console line is the source of truth and does not depend on this.
 *
 * SCHEMA (fixed positions — entries may be APPENDED, never reordered/removed):
 *
 *   index1  event_kind        (origin_error | upstream_latency)
 *   blob1   event_kind        blob7   path
 *   blob2   origin            blob8   method
 *   blob3   outcome_class     blob9   cf_colo
 *   blob4   cache_status      blob10  route_group
 *   blob5   api_family        blob11  status_class
 *   blob6   rpc_method        blob12  error_class
 *   double1 status            double3 sample_rate
 *   double2 duration_ms       double4 served_stale (1|0)
 *
 * `outcome_class` is the one field whose meaning depends on `event_kind`: it is
 * the `status_class` for an origin error and the `duration_bucket` for a
 * latency event, so a single GROUP BY works for both.
 *
 * @param {Record<string, any>} env
 * @param {object} event
 */
function writeEdgeEventDataPoint(env, event) {
  const dataset = env && env.EDGE_EVENTS_ANALYTICS;
  if (!dataset || typeof dataset.writeDataPoint !== "function") return;

  try {
    const kind = event.type === "edge_origin_error" ? "origin_error" : "upstream_latency";
    const outcomeClass =
      kind === "origin_error" ? event.status_class : event.duration_bucket || "";

    dataset.writeDataPoint({
      indexes: [kind],
      blobs: [
        kind,
        event.origin || "",
        outcomeClass,
        event.cache_status || "",
        event.api_family || "",
        event.rpc_method || "",
        event.path || "",
        event.method || "",
        event.cf_colo || "",
        event.route_group || "",
        event.status_class || "",
        event.error_class || "",
      ],
      doubles: [
        Number.isFinite(event.status) ? event.status : 0,
        Number.isFinite(event.duration_ms) ? event.duration_ms : 0,
        Number.isFinite(event.sample_rate) ? event.sample_rate : 1,
        event.served_stale ? 1 : 0,
      ],
    });
  } catch (_) {
    // Analytics Engine is a nice-to-have; the JSON line already landed.
  }
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

/**
 * Headers for the SYNTHESIZED public edge-read request.
 *
 * This path does not proxy the caller's request; it builds a fresh JSON-RPC one
 * and forwards that. Constructing headers from scratch is deliberate — the
 * response is cached and served to other people, so cookies and Authorization
 * must not ride along.
 *
 * But it also meant the caller's ADDRESS was discarded here, before
 * filterRequestHeaders ever ran, so the origin could only ever see Cloudflare.
 * Measured on 2026-08-31: after both the origin-side and proxy-side fixes had
 * shipped, 100% of quota rows were still growing on Cloudflare-keyed
 * identifiers with zero real client addresses, because this path never had one
 * to forward.
 *
 * The user-agent is copied — it carries the `shorted-web-ssr` marker stamped by
 * web/src/middleware.ts — so the bypass secret has to be copied with it. A
 * marker without its proof is exactly "first-party, unverified": our own
 * traffic, recognised as ours, and metered against a quota for want of a header
 * that was one line away.
 */
export function buildPublicEdgeReadHeaders(request) {
  const headers = new Headers();
  headers.set("Accept", "application/json");
  headers.set("Content-Type", "application/json");
  const userAgent = request.headers.get("user-agent");
  headers.set("User-Agent", userAgent || "Shorted-Edge-Read/1.0");

  // Who is calling. Cloudflare sets this and a client cannot spoof it through
  // Cloudflare; nothing is invented when it is absent (local dev, tests), where
  // the origin's fallback to the peer address is correct.
  const trueClientIp = request.headers.get("cf-connecting-ip");
  if (trueClientIp) {
    headers.set("CF-Connecting-IP", trueClientIp);
    headers.set("X-Forwarded-For", trueClientIp);
  }

  // The proof that goes with the marker in the user-agent above. Not a
  // credential for this request — it only distinguishes verified first-party
  // from unverified, i.e. whether our own rendering is monthly-metered.
  const ssrBypass = request.headers.get("x-shorted-ssr-bypass");
  if (ssrBypass) {
    headers.set("X-Shorted-Ssr-Bypass", ssrBypass);
  }

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
  // Bucketed latency, sampled independently. Same measurement as
  // edge_request.duration_ms, but as a low-cardinality DIMENSION so
  // "which RPCs are slow, and is the cache helping" is answerable in
  // Analytics Engine with no log pipeline. See buildUpstreamLatencyEvent.
  recordUpstreamLatency(request, env, response, origin, cacheTtl, started);
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

  // ADDITIVE, and deliberately so: the edge_request contract is queried
  // elsewhere, so these two fields are appended rather than reshaping anything.
  //
  // A 429 in this stream is ambiguous on its own — the ORIGIN also returns 429
  // from the app-layer limiter (services/pkg/ratelimit), and so does the
  // zone-level rule. These identify the edge-worker bucket specifically:
  // buildRateLimitResponse stamps X-Shorted-Cache: RATELIMITED and an
  // `edge-<n>s` scope, neither of which any other 429 producer sets.
  const rateLimitScope = response.headers.get("X-RateLimit-Scope") || "";
  const rateLimited =
    cacheStatus === "RATELIMITED" || (response.status === 429 && rateLimitScope.startsWith("edge-"));

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
    rate_limited: rateLimited,
    // The bucket that produced the 429, so this stream can be sliced the same
    // way edge_rate_limit is. "" for every non-rate-limited request.
    rate_limit_bucket: rateLimited ? response.headers.get("X-RateLimit-Bucket") || "" : "",
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
      } catch (err) {
        // KV read failed — fall through to origin (don't block on KV errors).
        // Correct behaviour, previously silent: a KV outage turns every
        // cacheable request into an origin fetch with no trace anywhere.
        recordKvError(env, request, { op: "get", keyKind: "prewarm", error: err, path });
      }
    }

    // Cache miss + KV miss — fetch from origin
    const originUrl = buildOriginUrl(origin, url);
    const originResp = await fetchOrigin(
      env,
      request,
      originUrl,
      {
        method: request.method,
        headers: filterRequestHeaders(request.headers),
        body: freshBody(),
      },
      { originBase: origin, path }
    );

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
        } catch (err) {
          // Non-fatal, but a persistently failing write means the KV tier
          // stops backstopping CF cache expiry across PoPs.
          recordKvError(env, request, { op: "put", keyKind: "prewarm", error: err, path });
        }
      })());
    }

    return clientResp;
  } catch {
    // If caching fails, fall through to origin
    const originUrl = buildOriginUrl(origin, url);
    if (requestBody === undefined && request.method !== "GET" && request.method !== "HEAD") {
      requestBody = await request.clone().arrayBuffer();
    }
    return fetchOrigin(
      env,
      request,
      originUrl,
      {
        method: request.method,
        headers: filterRequestHeaders(request.headers),
        body: requestBody ? requestBody.slice(0) : undefined,
      },
      // retried: this is the second attempt at the same origin for one client
      // request, so two events for one cf_ray means both attempts failed.
      { originBase: origin, path, retried: true }
    );
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
async function proxyWithHeaders(request, origin, cacheStatus, env = {}) {
  const reqUrl = new URL(request.url);
  const originUrl = buildOriginUrl(origin, reqUrl);
  const path = reqUrl.pathname;
  const requestBody = request.method !== "GET" && request.method !== "HEAD"
    ? await request.clone().arrayBuffer()
    : undefined;
  const freshBody = () => requestBody ? requestBody.slice(0) : undefined;

  try {
    const resp = await fetchOrigin(
      env,
      request,
      originUrl,
      {
        method: request.method,
        headers: filterRequestHeaders(request.headers),
        body: freshBody(),
      },
      { originBase: origin, path }
    );
    const clientResp = new Response(resp.body, resp);
    stampEdgeHeaders(clientResp, cacheStatus);
    return clientResp;
  } catch {
    return fetchOrigin(
      env,
      request,
      originUrl,
      {
        method: request.method,
        headers: filterRequestHeaders(request.headers),
        body: freshBody(),
      },
      { originBase: origin, path, retried: true }
    );
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

  const meta = { originBase: frontendOrigin, path: reqUrl.pathname };

  try {
    const resp = await fetchOrigin(
      env,
      request,
      originUrl,
      { method: request.method, headers, body: freshBody() },
      meta
    );

    const clientResp = new Response(resp.body, resp);
    // Mark as proxied through CF edge for observability
    clientResp.headers.set("X-Shorted-Edge", "cloudflare");
    clientResp.headers.set("X-Shorted-Cache", "BYPASS");
    return clientResp;
  } catch {
    return fetchOrigin(
      env,
      request,
      originUrl,
      { method: request.method, headers, body: freshBody() },
      { ...meta, retried: true }
    );
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
 * Filter request headers before forwarding to the origin: drop hop-by-hop and
 * Cloudflare metadata, but KEEP the one thing that says who is calling.
 *
 * WHY THE CLIENT IP IS RE-ADDED. Stripping `cf-connecting-ip` and
 * `x-forwarded-for` left the origin with no address but Cloudflare's own. On
 * 2026-08-30, the first day app-layer rate limiting ran, every identifier
 * written to api_usage_monthly was a Cloudflare address — so every caller
 * behind a colo shared one bucket, which at the anonymous tier is 30 requests
 * a minute for the entire colo. It had not rejected anyone yet only because
 * most traffic lands in a much larger first-party class.
 *
 * The inbound values are still deleted first, and that ordering is the security
 * property: a client-supplied `x-forwarded-for` is attacker-controlled and must
 * never survive, or a caller can choose their own rate-limit bucket by sending
 * a header. What we forward is Cloudflare's `cf-connecting-ip`, which
 * Cloudflare overwrites on the inbound request and a client therefore cannot
 * spoof through it.
 *
 * Nothing is fabricated off-platform: with no `cf-connecting-ip` (local dev,
 * tests) neither header is set, and the origin falls back to the peer address,
 * which is the correct answer there.
 *
 * The origin side of this contract is `resolveClientIP` in
 * services/pkg/ratelimit/http.go, which believes these headers only when the
 * rightmost forwarded hop is a published Cloudflare address. Both halves are
 * required; either alone does nothing.
 */
export function filterRequestHeaders(headers) {
  // Read BEFORE stripping: this is Cloudflare's value, not the client's.
  const trueClientIp = headers.get("cf-connecting-ip");

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

  if (trueClientIp) {
    filtered.set("CF-Connecting-IP", trueClientIp);
    // A single address, not a chain: the origin takes the rightmost hop, and
    // appending to a client-supplied list would hand it back the control we
    // just removed.
    filtered.set("X-Forwarded-For", trueClientIp);
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
async function handlePurge(env, request = null, started = Date.now()) {
  const hotEntriesCleared = hotCache.size;
  hotCache.clear();

  if (!env.EDGE_KV) {
    recordCachePurge(env, request, {
      outcome: "failed",
      reason: "kv-unbound",
      hotEntriesCleared,
      durationMs: Date.now() - started,
    });
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
    recordKvError(env, request, { op: "version-put", keyKind: "control", error: err });
    recordCachePurge(env, request, {
      outcome: "failed",
      reason: "kv-write-failed",
      hotEntriesCleared,
      durationMs: Date.now() - started,
    });
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

  recordCachePurge(env, request, {
    outcome: "purged",
    hotEntriesCleared,
    durationMs: Date.now() - started,
  });

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
