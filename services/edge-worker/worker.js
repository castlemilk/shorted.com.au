/**
 * Shorted Edge Cache Worker
 *
 * Intelligent edge caching proxy for api.shorted.com.au.
 * Routes to multiple Cloud Run backend origins with endpoint-aware TTLs.
 * Eventually consistent: cached responses may be up to TTL seconds stale.
 *
 * Origins (set via terraform environment bindings):
 *   SHORTS_API_ORIGIN   - Cloud Run Shorts API
 *   CHAT_SERVICE_ORIGIN  - Cloud Run Chat Service
 *   MARKET_DATA_ORIGIN   - Cloud Run Market Data API
 *
 * Cache TTLs:
 *   Top shorts (GetTopShorts, GetShortsTreeMap)  -> 60s
 *   News (GetNews*, GetAnnouncement*)             -> 120s
 *   Stock data (GetStock*, GetTimeSeries*, etc.)  -> 30s
 *   Market data (/market_data.v1.*)               -> 30s
 *   Default                                       -> 30s
 *
 * Pass-through (never cached):
 *   /health, /healthz                             - health checks -> Shorts API
 *   gRPC/Connect streaming headers                 - pass-through to Shorts API
 *   /chat.v1.*                                    - streaming -> Chat Service
 *   /register.v1.*                                - auth -> Shorts API
 *   /api/cache/purge                              - cache purge (requires secret)
 *   Unknown paths                                 - pass-through to Shorts API
 */

const worker = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    const defaults = {
      cacheTtlDefault: parseInt(env.CACHE_TTL_DEFAULT || "30", 10),
      cacheTtlTopShorts: parseInt(env.CACHE_TTL_TOP_SHORTS || "60", 10),
      cacheTtlStockData: parseInt(env.CACHE_TTL_STOCK_DATA || "30", 10),
      cacheTtlNews: parseInt(env.CACHE_TTL_NEWS || "120", 10),
    };

    const shortsApiOrigin = env.SHORTS_API_ORIGIN;
    const chatServiceOrigin = env.CHAT_SERVICE_ORIGIN;
    const marketDataOrigin = env.MARKET_DATA_ORIGIN;

    // --- 1. BYPASS: never cache these ---

    // Health checks -> Shorts API
    if (path === "/health" || path === "/healthz") {
      return proxyWithHeaders(request, shortsApiOrigin, "BYPASS");
    }

    // gRPC/Connect streaming indicators -> pass-through
    if (
      request.headers.get("connect-protocol-version") ||
      request.headers.get("grpc-timeout") ||
      request.headers.get("x-grpc-web")
    ) {
      return proxyWithHeaders(request, shortsApiOrigin, "BYPASS");
    }

    // Cache purge endpoint (requires shared secret)
    if (path === "/api/cache/purge" && request.method === "POST") {
      const purgeBody = await request.text();
      if (!env.CACHE_PURGE_SECRET || purgeBody !== env.CACHE_PURGE_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
      return handlePurge();
    }

    // Chat service -> Chat Service origin (streaming, never cache)
    if (path.includes("/chat.v1.")) {
      if (!chatServiceOrigin) {
        return new Response("Chat service not configured", { status: 404 });
      }
      return proxyWithHeaders(request, chatServiceOrigin, "BYPASS");
    }

    // Auth/register -> Shorts API (never cache)
    if (path.includes("/register.v1.")) {
      return proxyWithHeaders(request, shortsApiOrigin, "BYPASS");
    }

    // --- 2. MARKET DATA -> cache with stock_data TTL ---
    if (path.includes("/market_data.v1.")) {
      return handleCachedRequest(request, url, env, ctx, marketDataOrigin, defaults.cacheTtlStockData);
    }

    // --- 3. SHORTS API -> endpoint-aware caching ---
    if (path.includes("/shorts.v1alpha1.")) {
      const ttl = resolveShortsTtl(path, defaults);
      return handleCachedRequest(request, url, env, ctx, shortsApiOrigin, ttl);
    }

    // --- 4. UNKNOWN -> pass-through to Shorts API ---
    return proxyWithHeaders(request, shortsApiOrigin, "BYPASS");
  },
};

export default worker;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determine the cache TTL for a Shorts API path based on the RPC method name.
 */
function resolveShortsTtl(path, defaults) {
  if (/GetTopShorts|GetShortsTreeMap/.test(path)) {
    return defaults.cacheTtlTopShorts;
  }
  if (/GetNews|GetAnnouncement/.test(path)) {
    return defaults.cacheTtlNews;
  }
  if (/GetStock|GetTimeSeries|GetSearch|GetWatchlist|GetDirectorTrades/.test(path)) {
    return defaults.cacheTtlStockData;
  }
  return defaults.cacheTtlDefault;
}

/**
 * Handle a cacheable request: check cache -> fetch on miss -> store.
 */
async function handleCachedRequest(request, url, env, ctx, origin, cacheTtl) {
  try {
    const cache = caches.default;
    const cacheKey = await buildCacheKey(request, url);

    // Check edge cache
    const cached = await cache.match(cacheKey);
    if (cached) {
      const resp = new Response(cached.body, cached);
      resp.headers.set("X-Shorted-Cache", "HIT");
      resp.headers.set("X-Shorted-Edge", "cloudflare");
      return resp;
    }

    // Cache miss - fetch from origin
    const originUrl = buildOriginUrl(origin, url);
    const originResp = await fetch(originUrl, {
      method: request.method,
      headers: filterRequestHeaders(request.headers),
      body: request.method !== "GET" && request.method !== "HEAD"
        ? await request.arrayBuffer()
        : undefined,
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
    clientResp.headers.set("Cache-Control", `s-maxage=${cacheTtl}`);

    // Response to store in cache
    const cacheResp = new Response(body, {
      status: originResp.status,
      headers: new Headers(originResp.headers),
    });
    stampEdgeHeaders(cacheResp, "HIT");
    cacheResp.headers.set("Cache-Control", `s-maxage=${cacheTtl}`);

    // Store in edge cache (non-blocking)
    ctx.waitUntil(cache.put(cacheKey, cacheResp));

    return clientResp;
  } catch {
    // If caching fails, fall through to origin
    const originUrl = buildOriginUrl(origin, url);
    return fetch(originUrl, request);
  }
}

/**
 * Proxy a request to an origin without caching. Used for pass-through routes.
 */
async function proxyWithHeaders(request, origin, cacheStatus) {
  const reqUrl = new URL(request.url);
  const originUrl = buildOriginUrl(origin, reqUrl);

  try {
    const resp = await fetch(originUrl, {
      method: request.method,
      headers: filterRequestHeaders(request.headers),
      body: request.method !== "GET" && request.method !== "HEAD"
        ? await request.arrayBuffer()
        : undefined,
    });
    const clientResp = new Response(resp.body, resp);
    stampEdgeHeaders(clientResp, cacheStatus);
    return clientResp;
  } catch {
    return fetch(originUrl, request);
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
 * Includes auth token hash to prevent cross-user cache pollution.
 * Cache API requires GET requests as keys.
 */
async function buildCacheKey(request, url) {
  const cacheUrl = new URL(url.toString());

  if (request.method === "POST") {
    const body = await request.clone().text();
    const bodyHash = await hashString(body);
    cacheUrl.searchParams.set("_bh", bodyHash);
  }

  // Include auth in cache key to prevent cross-tenant pollution
  const authHeader = request.headers.get("authorization") || "anon";
  const authHash = await hashString(authHeader);
  cacheUrl.searchParams.set("_a", authHash.substring(0, 8));

  // Cache API only supports GET
  return new Request(cacheUrl.toString(), { method: "GET" });
}

/**
 * Handle cache purge requests.
 * Returns an acknowledgement - cache entries expire within their TTL.
 */
function handlePurge() {
  return new Response(
    JSON.stringify({
      status: "acknowledged",
      message: "Cache will expire within TTL",
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
