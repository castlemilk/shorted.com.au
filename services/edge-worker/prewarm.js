/**
 * Shorted KV Pre-Warm Worker
 *
 * Populates the edge KV cache with hot responses after daily ASIC data sync.
 * Runs once per day via Cloudflare cron trigger at 12 PM UTC (2h after daily sync).
 * All users worldwide then read from KV instead of hitting origin.
 *
 * Trigger: Cloudflare Workers Cron Trigger (primary) or HTTP POST (manual)
 * Endpoints warmed:
 *   - Shorts API: GetTopShorts (1m, 3m, 6m, 1y) — 4 entries
 *                   GetIndustryTreeMap (3m, 6m)    — 2 entries
 *                   GetStock (top 10 ASX stocks)    — 10 entries
 *   - Market Data: GetStockPrice (top 10 stocks)    — 10 entries
 *                   GetHistoricalPrices (top 5)       — 5 entries
 *                   GetMultipleStockPrices             — 1 entry (top 20)
 *
 * This worker does NOT serve user traffic — it's invoked by scheduler only.
 */

const PREWARM_KV = "SHORTED_EDGE_CACHE"; // KV namespace binding name

// Hot endpoints to pre-warm after daily sync
const PREWARM_ENDPOINTS = [
  // Top shorts — most important, all periods (4 entries)
  { path: "/shorts.v1alpha1.ShortedStocksService/GetTopShorts", body: { period: "1m", limit: 10, summary_only: true }, origin: "shorts" },
  { path: "/shorts.v1alpha1.ShortedStocksService/GetTopShorts", body: { period: "3m", limit: 10, summary_only: true }, origin: "shorts" },
  { path: "/shorts.v1alpha1.ShortedStocksService/GetTopShorts", body: { period: "6m", limit: 10, summary_only: true }, origin: "shorts" },
  { path: "/shorts.v1alpha1.ShortedStocksService/GetTopShorts", body: { period: "1y", limit: 10, summary_only: true }, origin: "shorts" },
  // Industry treemap (2 entries)
  { path: "/shorts.v1alpha1.ShortedStocksService/GetIndustryTreeMap", body: { period: "3m", limit: 20 }, origin: "shorts" },
  { path: "/shorts.v1alpha1.ShortedStocksService/GetIndustryTreeMap", body: { period: "6m", limit: 20 }, origin: "shorts" },
  // Weekly report (2 periods — heavy endpoint, worth pre-warming)
  { path: "/shorts.v1alpha1.ShortedStocksService/GetWeeklyReport", body: { period: "1w" }, origin: "shorts" },
  { path: "/shorts.v1alpha1.ShortedStocksService/GetWeeklyReport", body: { period: "4w" }, origin: "shorts" },
  // Available dates (static — only changes when new ASIC data is released)
  { path: "/shorts.v1alpha1.ShortedStocksService/GetAvailableDates", body: {}, origin: "shorts" },
  // Top 20 individual stocks (most watched — expanded from 10)
  { path: "/shorts.v1alpha1.ShortedStocksService/GetStock", body: { product_code: "CBA" }, origin: "shorts" },
  { path: "/shorts.v1alpha1.ShortedStocksService/GetStock", body: { product_code: "BHP" }, origin: "shorts" },
  { path: "/shorts.v1alpha1.ShortedStocksService/GetStock", body: { product_code: "PLS" }, origin: "shorts" },
  { path: "/shorts.v1alpha1.ShortedStocksService/GetStock", body: { product_code: "LYC" }, origin: "shorts" },
  { path: "/shorts.v1alpha1.ShortedStocksService/GetStock", body: { product_code: "MIN" }, origin: "shorts" },
  { path: "/shorts.v1alpha1.ShortedStocksService/GetStock", body: { product_code: "NCM" }, origin: "shorts" },
  { path: "/shorts.v1alpha1.ShortedStocksService/GetStock", body: { product_code: "ANZ" }, origin: "shorts" },
  { path: "/shorts.v1alpha1.ShortedStocksService/GetStock", body: { product_code: "WBC" }, origin: "shorts" },
  { path: "/shorts.v1alpha1.ShortedStocksService/GetStock", body: { product_code: "RIO" }, origin: "shorts" },
  { path: "/shorts.v1alpha1.ShortedStocksService/GetStock", body: { product_code: "CSL" }, origin: "shorts" },
  { path: "/shorts.v1alpha1.ShortedStocksService/GetStock", body: { product_code: "FMG" }, origin: "shorts" },
  { path: "/shorts.v1alpha1.ShortedStocksService/GetStock", body: { product_code: "WOW" }, origin: "shorts" },
  { path: "/shorts.v1alpha1.ShortedStocksService/GetStock", body: { product_code: "TLS" }, origin: "shorts" },
  { path: "/shorts.v1alpha1.ShortedStocksService/GetStock", body: { product_code: "NAB" }, origin: "shorts" },
  { path: "/shorts.v1alpha1.ShortedStocksService/GetStock", body: { product_code: "MQG" }, origin: "shorts" },
  { path: "/shorts.v1alpha1.ShortedStocksService/GetStock", body: { product_code: "WES" }, origin: "shorts" },
  { path: "/shorts.v1alpha1.ShortedStocksService/GetStock", body: { product_code: "SUN" }, origin: "shorts" },
  { path: "/shorts.v1alpha1.ShortedStocksService/GetStock", body: { product_code: "ALQ" }, origin: "shorts" },
  { path: "/shorts.v1alpha1.ShortedStocksService/GetStock", body: { product_code: "BXB" }, origin: "shorts" },
  // Market news (2 entries — news is highly cacheable)
  { path: "/shorts.v1alpha1.ShortedStocksService/GetNews", body: { limit: 20 }, origin: "shorts" },
  { path: "/shorts.v1alpha1.ShortedStocksService/GetAnnouncement", body: { limit: 20 }, origin: "shorts" },
  // Market data — latest prices for top 20 stocks
  { path: "/marketdata.v1.MarketDataService/GetStockPrice", body: { stock_code: "CBA" }, origin: "market" },
  { path: "/marketdata.v1.MarketDataService/GetStockPrice", body: { stock_code: "BHP" }, origin: "market" },
  { path: "/marketdata.v1.MarketDataService/GetStockPrice", body: { stock_code: "PLS" }, origin: "market" },
  { path: "/marketdata.v1.MarketDataService/GetStockPrice", body: { stock_code: "LYC" }, origin: "market" },
  { path: "/marketdata.v1.MarketDataService/GetStockPrice", body: { stock_code: "MIN" }, origin: "market" },
  { path: "/marketdata.v1.MarketDataService/GetStockPrice", body: { stock_code: "NCM" }, origin: "market" },
  { path: "/marketdata.v1.MarketDataService/GetStockPrice", body: { stock_code: "ANZ" }, origin: "market" },
  { path: "/marketdata.v1.MarketDataService/GetStockPrice", body: { stock_code: "WBC" }, origin: "market" },
  { path: "/marketdata.v1.MarketDataService/GetStockPrice", body: { stock_code: "RIO" }, origin: "market" },
  { path: "/marketdata.v1.MarketDataService/GetStockPrice", body: { stock_code: "CSL" }, origin: "market" },
  { path: "/marketdata.v1.MarketDataService/GetStockPrice", body: { stock_code: "FMG" }, origin: "market" },
  { path: "/marketdata.v1.MarketDataService/GetStockPrice", body: { stock_code: "WOW" }, origin: "market" },
  { path: "/marketdata.v1.MarketDataService/GetStockPrice", body: { stock_code: "TLS" }, origin: "market" },
  { path: "/marketdata.v1.MarketDataService/GetStockPrice", body: { stock_code: "NAB" }, origin: "market" },
  { path: "/marketdata.v1.MarketDataService/GetStockPrice", body: { stock_code: "MQG" }, origin: "market" },
  { path: "/marketdata.v1.MarketDataService/GetStockPrice", body: { stock_code: "WES" }, origin: "market" },
  { path: "/marketdata.v1.MarketDataService/GetStockPrice", body: { stock_code: "SUN" }, origin: "market" },
  { path: "/marketdata.v1.MarketDataService/GetStockPrice", body: { stock_code: "ALQ" }, origin: "market" },
  { path: "/marketdata.v1.MarketDataService/GetStockPrice", body: { stock_code: "BXB" }, origin: "market" },
  // Historical prices (top 10)
  { path: "/marketdata.v1.MarketDataService/GetHistoricalPrices", body: { stock_code: "CBA", period: "3m" }, origin: "market" },
  { path: "/marketdata.v1.MarketDataService/GetHistoricalPrices", body: { stock_code: "BHP", period: "3m" }, origin: "market" },
  { path: "/marketdata.v1.MarketDataService/GetHistoricalPrices", body: { stock_code: "PLS", period: "3m" }, origin: "market" },
  { path: "/marketdata.v1.MarketDataService/GetHistoricalPrices", body: { stock_code: "LYC", period: "3m" }, origin: "market" },
  { path: "/marketdata.v1.MarketDataService/GetHistoricalPrices", body: { stock_code: "MIN", period: "3m" }, origin: "market" },
  { path: "/marketdata.v1.MarketDataService/GetHistoricalPrices", body: { stock_code: "NCM", period: "3m" }, origin: "market" },
  { path: "/marketdata.v1.MarketDataService/GetHistoricalPrices", body: { stock_code: "ANZ", period: "3m" }, origin: "market" },
  { path: "/marketdata.v1.MarketDataService/GetHistoricalPrices", body: { stock_code: "WBC", period: "3m" }, origin: "market" },
  { path: "/marketdata.v1.MarketDataService/GetHistoricalPrices", body: { stock_code: "RIO", period: "3m" }, origin: "market" },
  { path: "/marketdata.v1.MarketDataService/GetHistoricalPrices", body: { stock_code: "CSL", period: "3m" }, origin: "market" },
  // Bulk price fetch (already covers top 20)
  { path: "/marketdata.v1.MarketDataService/GetMultipleStockPrices", body: { stock_codes: ["CBA", "BHP", "PLS", "LYC", "MIN", "NCM", "ANZ", "WBC", "RIO", "CSL", "FMG", "FMG", "WOW", "TLS", "NAB", "MQG", "WES", "SUN", "ALQ", "BXB"] }, origin: "market" },
];

const worker = {
  // HTTP handler — for manual or scheduler-triggered pre-warm
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const secret=request.headers.get("x-prewarm-secret");
    if (!env.PREWARM_SECRET || secret !== env.PREWARM_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }

    const origins = {
      shorts: env.SHORTS_API_ORIGIN,
      market: env.MARKET_DATA_ORIGIN,
    };
    if (!origins.shorts) {
      return new Response("SHORTS_API_ORIGIN not configured", { status: 500 });
    }

    const results = await prewarmAll(env, origins);

    const summary = {
      timestamp: new Date().toISOString(),
      total: results.length,
      succeeded: results.filter(r => r.ok).length,
      failed: results.filter(r => !r.ok).length,
      entries: results,
    };

    const status = summary.failed === 0 ? 200 : 207;
    return new Response(JSON.stringify(summary, null, 2), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  },

  // Cron trigger handler — Cloudflare Workers Cron Trigger invokes this
  // Runs once per day at 12 PM UTC (2 hours after daily sync completes)
  async scheduled(controller, env, ctx) {
    const origins = {
      shorts: env.SHORTS_API_ORIGIN,
      market: env.MARKET_DATA_ORIGIN,
    };
    await prewarmAll(env, origins);
  },
};

export default worker;

/**
 * Fetch all pre-warm endpoints and write to KV.
 * @param {object} env - Worker env bindings
 * @param {object} origins - Dict of { shorts: string, market: string }
 */
async function prewarmAll(env, origins) {
  const kv = env[PREWARM_KV];
  if (!kv) {
    throw new Error(`KV namespace ${PREWARM_KV} not bound`);
  }

  const results = [];

  for (const endpoint of PREWARM_ENDPOINTS) {
    const key = buildKvKey(endpoint);
    const origin = origins[endpoint.origin] || origins.shorts;
    if (!origin) {
      results.push({ key, ok: false, error: `No origin for ${endpoint.origin}` });
      continue;
    }
    try {
      const resp = await fetch(`${origin}${endpoint.path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(endpoint.body),
      });

      if (!resp.ok) {
        results.push({ key, ok: false, status: resp.status, error: `HTTP ${resp.status}` });
        continue;
      }

      const text = await resp.text();
      // Expire at midnight UTC — next pre-warm will refresh within 24 hours
      await kv.put(key, text, { expirationTtl: 86400 }); // 24h TTL max
      results.push({ key, ok: true, size: text.length, origin: endpoint.origin });
    } catch (err) {
      results.push({ key, ok: false, error: err.message });
    }
  }

  return results;
}

/**
 * Build a deterministic KV key for an endpoint.
 */
function buildKvKey(endpoint) {
  const bodyHash = hashStringSync(JSON.stringify(endpoint.body));
  const pathClean = endpoint.path.replace(/\//g, "_").replace(/^_/, "");
  return `prewarm:${pathClean}:${bodyHash}`;
}

/**
 * Deterministic hash without async crypto API (for use in key building).
 * Must produce the same output as the main edge worker's hashStringSync.
 */
function hashStringSync(text) {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Get seconds until midnight UTC.
 */
function getMidnightUtc() {
  const now = new Date();
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
  return Math.round((midnight.getTime() - now.getTime()) / 1000);
}
