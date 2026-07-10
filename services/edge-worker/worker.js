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
    // Forward CF-Connecting-IP so Vercel Upstash rate limiting gets the real client IP.
    // Cloudflare DDoS + WAF protect this traffic at the proxy layer.
    if (hostname === FRONTEND_HOST || hostname === `www.${FRONTEND_HOST}`) {
      return withEdgeAnalytics(request, env, proxyFrontend(request, env, FRONTEND_ORIGIN), "frontend", 0, started);
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

function resolvePublicEdgeReadRoute(url) {
  const path = url.pathname;
  const params = url.searchParams;

  if (path === `${EDGE_READ_PREFIX}/top-shorts`) {
    const body = {
      period: edgePeriod(params, "period", "3m"),
      limit: edgeInt(params, "limit", 10, 1, 500),
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
function resolveShortsTtl(path, defaults) {
  if (/GetTopShorts|GetIndustryTreeMap|GetShortsTreeMap|GetWeeklyReport|GetMarketByDate|GetAvailableDates/.test(path)) {
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
          clientResp.headers.set("Cache-Control", `s-maxage=${cacheTtl}, stale-while-revalidate=${cacheTtl}`);

          // Non-blocking: repopulate CF cache for this PoP from KV. A KV hit
          // should not immediately create another origin request.
          safeWaitUntil(ctx, (async () => {
            try {
              const cacheResp = new Response(kvValue, {
                status: 200,
                headers: { "Content-Type": "application/json" },
              });
              stampEdgeHeaders(cacheResp, "HIT");
              cacheResp.headers.set("Cache-Control", `s-maxage=${cacheTtl}, stale-while-revalidate=${cacheTtl}`);
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
    clientResp.headers.set("Cache-Control", `s-maxage=${cacheTtl}, stale-while-revalidate=${cacheTtl}`);

    // Response to store in CF cache
    const cacheResp = new Response(body.slice(0), {
      status: originResp.status,
      headers: cacheableResponseHeaders(originResp, cacheTtl),
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

function cacheableResponseHeaders(originResp, cacheTtl) {
  const headers = new Headers();
  const contentType = originResp.headers.get("Content-Type") || originResp.headers.get("content-type");
  if (contentType) {
    headers.set("Content-Type", contentType);
  }
  headers.set("Cache-Control", `s-maxage=${cacheTtl}, stale-while-revalidate=${cacheTtl}`);
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
async function buildKvCacheKey(request, path, cacheVersion = DEFAULT_CACHE_VERSION) {
  if (!/GetTopShorts|GetIndustryTreeMap|GetShortsTreeMap|GetWeeklyReport|GetAvailableDates|GetMarketByDate|GetStock$|GetStockDetails|GetStockData|GetStockNews|GetStockFinancialHighlights|GetNews|GetAnnouncement|GetMarketNews|GetStockPrice|GetMultipleStockPrices|GetHistoricalPrices/.test(path)) {
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
