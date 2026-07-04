// Lightweight client for the public shorted.com.au API. Uses fetch
// and JSON over Connect-RPC. No protobuf deps — keeps the script
// self-contained and avoids the BigInt-serialisation footgun we hit
// elsewhere.

const API_URL = process.env.SHORTED_API_URL ?? "https://api.shorted.com.au";

// Default headers mimic a browser so the anti-bot WAF doesn't return 403.
const DEFAULT_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  Origin: "https://shorted.com.au",
  Referer: "https://shorted.com.au/",
};

async function call<T>(
  endpoint: string,
  body: object,
  opts: { internal?: boolean } = {},
): Promise<T> {
  // Cloudflare edge worker intermittently returns 1101 ("Worker threw
  // exception") on api.shorted.com.au. Retry transient 5xx with backoff.
  const maxAttempts = 4;
  let lastErr: Error | null = null;

  const headers: Record<string, string> = { ...DEFAULT_HEADERS };
  if (opts.internal) {
    const secret = process.env.INTERNAL_SERVICE_SECRET;
    const email = process.env.SHORTED_BOT_EMAIL ?? "ben@shorted.com.au";
    if (!secret) {
      throw new Error(
        `${endpoint}: INTERNAL_SERVICE_SECRET not set; admin RPC will be denied`,
      );
    }
    headers["x-internal-secret"] = secret;
    headers["x-user-email"] = email;
    headers["x-user-id"] = email;
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(
      `${API_URL}/shorts.v1alpha1.ShortedStocksService/${endpoint}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      },
    );
    if (res.ok) return (await res.json()) as T;
    const text = await res.text();
    lastErr = new Error(`${endpoint} -> HTTP ${res.status}: ${text.slice(0, 200)}`);
    if (res.status < 500 || attempt === maxAttempts) throw lastErr;
    await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
  throw lastErr ?? new Error(`${endpoint} failed after ${maxAttempts} attempts`);
}

export interface TopShortsItem {
  productCode: string;
  name: string;
  latestShortPosition?: number; // in summary mode this is current %
  points?: Array<{ timestamp: { seconds: string }; shortPosition: number }>;
}

export interface TopShortsResponse {
  timeSeries: TopShortsItem[];
}

export async function getTopShorts(opts: {
  period?: string;
  limit?: number;
  summaryOnly?: boolean;
}): Promise<TopShortsItem[]> {
  const resp = await call<TopShortsResponse>("GetTopShorts", {
    period: opts.period ?? "1y",
    limit: opts.limit ?? 50,
    offset: 0,
    summaryOnly: opts.summaryOnly ?? true,
  });
  return resp.timeSeries ?? [];
}

export interface StockSeries {
  productCode: string;
  name: string;
  points: Array<{ date: Date; shortPosition: number }>;
}

export async function getStockHistory(
  stockCode: string,
  period = "3m",
): Promise<StockSeries | null> {
  // protobuf Timestamps serialise to ISO strings over JSON (not the
  // `{seconds, nanos}` shape used on the wire).
  const resp = await call<{
    productCode?: string;
    name?: string;
    points?: Array<{ timestamp?: string; shortPosition?: number }>;
  }>("GetStockData", { productCode: stockCode, period });
  if (!resp.productCode) return null;
  const points = (resp.points ?? [])
    .map((p) => ({
      date: p.timestamp ? new Date(p.timestamp) : new Date(0),
      shortPosition: p.shortPosition ?? 0,
    }))
    .filter((p) => !Number.isNaN(p.date.getTime()) && p.date.getTime() > 0)
    .sort((a, b) => a.date.getTime() - b.date.getTime());
  return {
    productCode: resp.productCode,
    name: resp.name ?? resp.productCode,
    points,
  };
}

export interface NewsArticle {
  id: string;
  stockCode: string;
  source: string;
  headline: string;
  url: string;
  publishedAt?: { seconds: string };
  sentiment?: string;
  isPriceSensitive?: boolean;
  imageUrl?: string;
}

export async function getMarketNews(opts: {
  limit?: number;
  priceSensitiveOnly?: boolean;
}): Promise<NewsArticle[]> {
  const resp = await call<{ articles?: NewsArticle[] }>("GetMarketNews", {
    limit: opts.limit ?? 30,
    priceSensitiveOnly: opts.priceSensitiveOnly ?? false,
  });
  return resp.articles ?? [];
}

export interface DirectorTrade {
  id: string;
  stockCode: string;
  directorName: string;
  tradeType: string;
  sharesTraded?: string;
  pricePerShare?: number;
  totalValue?: number;
  tradeDate: string;
  announcementUrl?: string;
}

export async function getDirectorTrades(
  stockCode: string,
  limit = 10,
): Promise<DirectorTrade[]> {
  const resp = await call<{ trades?: DirectorTrade[] }>("GetDirectorTrades", {
    stockCode,
    limit,
  });
  return resp.trades ?? [];
}

// ============================================================
// Editorial Takes
// ============================================================

export interface EditorialTake {
  id: string;
  slug: string;
  headline: string;
  stockCode?: string;
  bodyMd: string;
  sentiment?: string;
  sourceArticleId?: string;
  sourceUrl?: string;
  sourceName?: string;
  ogImageUrl?: string;
  heroImageUrl?: string;
  publishedAt?: string;
}

/**
 * Find the most relevant published Take for a (stockCode, headline).
 * Returns the first published Take for the stock whose headline
 * substantially matches the source article headline — by exact or
 * normalised match. Imperfect but cheap; the alternative is matching
 * source_article_id which requires the bot to know the article UUID.
 */
export async function findTakeForStockHeadline(
  stockCode: string,
  headline: string,
): Promise<EditorialTake | null> {
  try {
    const resp = await call<{ takes?: EditorialTake[] }>(
      "ListEditorialTakes",
      { stockCode, limit: 10, offset: 0 },
    );
    const takes = resp.takes ?? [];
    if (takes.length === 0) return null;
    const norm = (s: string) =>
      s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const target = norm(headline);
    // Exact normalised match wins; otherwise look for shared n-grams.
    const exact = takes.find((t) => norm(t.headline) === target);
    if (exact) return exact;
    const tokens = new Set(target.split(/\s+/).filter((w) => w.length > 3));
    if (tokens.size === 0) return takes[0] ?? null;
    let bestScore = 0;
    let best: EditorialTake | null = null;
    for (const t of takes) {
      const tTokens = norm(t.headline).split(/\s+/).filter((w) => w.length > 3);
      const overlap = tTokens.filter((w) => tokens.has(w)).length;
      if (overlap > bestScore) {
        bestScore = overlap;
        best = t;
      }
    }
    // Need at least 3 shared significant tokens to call it a match.
    return bestScore >= 3 ? best : null;
  } catch {
    return null;
  }
}

// ============================================================
// Admin: tweet publish queue (called by process-publish-queue)
// ============================================================

export async function listTweetPublishQueue(limit = 10): Promise<EditorialTake[]> {
  const resp = await call<{ takes?: EditorialTake[] }>(
    "ListTweetPublishQueue",
    { limit },
    { internal: true },
  );
  return resp.takes ?? [];
}

export async function markTakeTweetPublished(slug: string): Promise<EditorialTake | null> {
  const resp = await call<{ take?: EditorialTake }>(
    "MarkTakeTweetPublished",
    { slug },
    { internal: true },
  );
  return resp.take ?? null;
}

// ============================================================
// Battleground / Squeeze radar
// ============================================================

export type BattlegroundView =
  | "BATTLEGROUND_VIEW_SQUEEZE"
  | "BATTLEGROUND_VIEW_DIVERGENCE"
  | "BATTLEGROUND_VIEW_UNSPECIFIED";

export interface BattlegroundStock {
  stockCode: string;
  companyName?: string;
  industry?: string;
  shortPct?: number;
  shortPctChange4w?: number;
  priceChange1m?: number;
  daysToCover?: number;
  squeezeScore?: number;
  divergenceScore?: number;
}

/**
 * Heuristic: a Cloudflare WAF challenge / edge-worker error page (or any
 * non-JSON body) comes back as HTML, not JSON. `res.json()` would throw a
 * SyntaxError on it — same failure mode the other methods rely on — but for
 * the graceful path we sniff the body/content-type first so we can return a
 * clean "unavailable" signal instead of a stack trace.
 */
function looksLikeNonJson(contentType: string | null, body: string): boolean {
  if (contentType && /text\/html|text\/plain/i.test(contentType)) return true;
  const head = body.trimStart().slice(0, 1).toLowerCase();
  return head === "<"; // "<!doctype html>" / "<html" / Cloudflare challenge
}

/**
 * Fetch squeeze/divergence battleground candidates.
 *
 * Returns `null` (NOT throw) when the endpoint is unavailable — a 404
 * (GetBattlegroundStocks is not yet deployed to prod), a WAF/edge HTML
 * response, or any non-JSON body. Callers treat `null` as "skip quietly".
 * A deployed-but-empty result is `[]`, which is distinct from `null`.
 *
 * Mirrors `call()`'s conventions: same base URL + browser-ish headers, plus
 * the `Connect-Protocol-Version: 1` header a Connect JSON POST expects, and
 * the same transient-5xx retry/backoff.
 */
export async function getBattlegroundStocks(
  view: BattlegroundView,
  limit = 5,
): Promise<BattlegroundStock[] | null> {
  const endpoint = "GetBattlegroundStocks";
  const maxAttempts = 4;
  const headers: Record<string, string> = {
    ...DEFAULT_HEADERS,
    "Connect-Protocol-Version": "1",
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(
        `${API_URL}/shorts.v1alpha1.ShortedStocksService/${endpoint}`,
        { method: "POST", headers, body: JSON.stringify({ view, limit }) },
      );
    } catch (err) {
      // Network error — retry transiently, then give up gracefully.
      if (attempt === maxAttempts) {
        console.warn(`[twitter] ${endpoint} network error: ${String(err)}`);
        return null;
      }
      await new Promise((r) => setTimeout(r, 1000 * attempt));
      continue;
    }

    const contentType = res.headers.get("content-type");

    if (res.ok) {
      const text = await res.text();
      // WAF can return HTTP 200 with an HTML interstitial — treat as down.
      if (looksLikeNonJson(contentType, text)) {
        console.warn(`[twitter] ${endpoint} returned non-JSON (WAF?) — skipping`);
        return null;
      }
      try {
        const resp = JSON.parse(text) as { stocks?: BattlegroundStock[] };
        return resp.stocks ?? [];
      } catch {
        console.warn(`[twitter] ${endpoint} JSON parse failed — skipping`);
        return null;
      }
    }

    // 404 = not deployed yet; 501/CodeUnimplemented likewise → unavailable.
    if (res.status === 404 || res.status === 501) return null;

    // Retry transient 5xx; otherwise (403/WAF/etc.) degrade gracefully.
    if (res.status >= 500 && attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, 1000 * attempt));
      continue;
    }

    const text = await res.text().catch(() => "");
    console.warn(
      `[twitter] ${endpoint} -> HTTP ${res.status}${
        looksLikeNonJson(contentType, text) ? " (WAF HTML)" : ""
      } — skipping`,
    );
    return null;
  }
  return null;
}
