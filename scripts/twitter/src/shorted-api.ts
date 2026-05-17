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

async function call<T>(endpoint: string, body: object): Promise<T> {
  const res = await fetch(
    `${API_URL}/shorts.v1alpha1.ShortedStocksService/${endpoint}`,
    {
      method: "POST",
      headers: DEFAULT_HEADERS,
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    throw new Error(`${endpoint} -> HTTP ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
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
  const resp = await call<{
    timestamp?: { seconds?: string };
    productCode?: string;
    name?: string;
    points?: Array<{ timestamp?: { seconds?: string }; shortPosition?: number }>;
  }>("GetStockData", { productCode: stockCode, period });
  if (!resp.productCode) return null;
  const points = (resp.points ?? [])
    .map((p) => ({
      date: new Date(Number(p.timestamp?.seconds ?? 0) * 1000),
      shortPosition: p.shortPosition ?? 0,
    }))
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
