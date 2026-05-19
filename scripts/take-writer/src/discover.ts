// Discover candidate Take subjects from live ASX data.
//
// Pulls top short positions + biggest WoW movers, filters out ETFs and
// other low-signal subjects, cross-checks against the news feed, and
// ranks the remainder so the take-writer focuses on stocks where there's
// both an interesting data story AND real news coverage.

const API_URL =
  process.env.SHORTED_API_URL ?? "https://api.shorted.com.au";

const BROWSER_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  Origin: "https://shorted.com.au",
  Referer: "https://shorted.com.au/",
};

async function call<T>(endpoint: string, body: object): Promise<T> {
  for (let i = 1; i <= 4; i++) {
    const res = await fetch(
      `${API_URL}/shorts.v1alpha1.ShortedStocksService/${endpoint}`,
      { method: "POST", headers: BROWSER_HEADERS, body: JSON.stringify(body) },
    );
    if (res.ok) return (await res.json()) as T;
    if (res.status < 500 || i === 4) {
      throw new Error(`${endpoint} -> HTTP ${res.status}`);
    }
    await new Promise((r) => setTimeout(r, 800 * i));
  }
  throw new Error("unreachable");
}

interface TopShortsItem {
  productCode: string;
  name: string;
  latestShortPosition?: number;
}

interface NewsArticle {
  id: string;
  stockCode?: string;
  source?: string;
  headline?: string;
  url?: string;
  publishedAt?: { seconds?: bigint | number } | string;
  sentiment?: string;
  isPriceSensitive?: boolean;
  summary?: string;
}

export interface Candidate {
  stockCode: string;
  name: string;
  shortPct: number;
  recentNews: NewsArticle[];
  priceSensitiveCount: number;
  topHeadline?: string;
  topSource?: string;
  topSentiment?: string;
  score: number;
  rationale: string;
}

// Name patterns that mark a stock as NOT a Take candidate.
// PERSONA.md: Takes should be about real companies with real stories,
// not ETF baskets or low-signal wrapper products.
const SKIP_NAME_PATTERNS: RegExp[] = [
  /\bETF\b/i,
  /\bETF UNITS\b/i,
  /\bETF$/i,
  /\bUNITS$/i,
  /\bINDEX\b/i,
  /\bINDEX FUND\b/i,
  /\bTRUST\b/i, // most "TRUST" names on ASX are managed funds / REITs
  /\bMANAGED FUND\b/i,
];

function isLowSignalName(name: string): { skip: boolean; reason?: string } {
  for (const rx of SKIP_NAME_PATTERNS) {
    if (rx.test(name)) {
      return { skip: true, reason: `name matches /${rx.source}/` };
    }
  }
  return { skip: false };
}

function ageHoursOf(article: NewsArticle): number {
  const ts = article.publishedAt;
  if (!ts) return Infinity;
  if (typeof ts === "string") {
    const d = new Date(ts);
    return (Date.now() - d.getTime()) / 3_600_000;
  }
  const s =
    typeof ts.seconds === "bigint"
      ? Number(ts.seconds)
      : typeof ts.seconds === "number"
        ? ts.seconds
        : 0;
  if (!s) return Infinity;
  return (Date.now() - s * 1000) / 3_600_000;
}

interface DiscoverOptions {
  poolSize: number;       // how many top-shorted stocks to consider
  newsWindowHours: number; // only count news within this window
  topN: number;            // how many candidates to return
}

export async function discoverCandidates(
  opts: Partial<DiscoverOptions> = {},
): Promise<Candidate[]> {
  const cfg: DiscoverOptions = {
    poolSize: opts.poolSize ?? 30,
    newsWindowHours: opts.newsWindowHours ?? 7 * 24,
    topN: opts.topN ?? 5,
  };

  console.error(`[discover] fetching top ${cfg.poolSize} shorted stocks…`);
  const topResp = await call<{ timeSeries?: TopShortsItem[] }>(
    "GetTopShorts",
    { period: "1y", limit: cfg.poolSize, offset: 0, summaryOnly: true },
  );
  const pool = topResp.timeSeries ?? [];
  console.error(`[discover] pool size: ${pool.length}`);

  // Pull market news once and bucket by mentioned ticker. Most news_articles
  // are tagged with stockCode='ASX' (market-wide), so per-stock GetStockNews
  // misses them. Headline keyword matching against the top-shorts pool is
  // more permissive and surfaces real signal.
  console.error(`[discover] fetching market news (limit 200)…`);
  const newsResp = await call<{ articles?: NewsArticle[] }>("GetMarketNews", {
    limit: 200,
    priceSensitiveOnly: false,
  });
  // GetMarketNews returns articles sorted by published_at DESC. The
  // publishedAt field is currently dropped from the JSON response (proto3
  // empty-field elision when the DB column is NULL — backend TODO). Take
  // the first `cfg.newsWindowHours / 24 * 30` rows as a recency proxy
  // (~30 articles per day is the rough rate).
  const recencyApprox = Math.max(50, Math.round((cfg.newsWindowHours / 24) * 30));
  const allNews = (newsResp.articles ?? []).slice(0, recencyApprox);
  console.error(`[discover] news fetched: ${(newsResp.articles ?? []).length}, recency-bounded: ${allNews.length}`);

  const newsByTicker = new Map<string, NewsArticle[]>();
  for (const stock of pool) {
    const code = stock.productCode;
    // Match if article's stockCode equals the ticker OR the headline
    // mentions the ticker as a whole word.
    const headlineRx = new RegExp(`\\b${code}\\b`);
    const hits = allNews.filter(
      (a) =>
        a.stockCode === code ||
        (a.headline && headlineRx.test(a.headline)) ||
        (a.summary && headlineRx.test(a.summary)),
    );
    if (hits.length > 0) newsByTicker.set(code, hits);
  }
  console.error(`[discover] tickers with news: ${newsByTicker.size}`);

  const candidates: Candidate[] = [];

  for (const stock of pool) {
    const code = stock.productCode;
    const filter = isLowSignalName(stock.name);
    if (filter.skip) {
      console.error(`[discover]   skip ${code}: ${filter.reason}`);
      continue;
    }

    const news = newsByTicker.get(code) ?? [];
    if (news.length === 0) {
      console.error(`[discover]   skip ${code}: no news mentions in last ${cfg.newsWindowHours}h`);
      continue;
    }

    const priceSensitive = news.filter((a) => a.isPriceSensitive).length;
    const shortPct = stock.latestShortPosition ?? 0;

    // Score: short % weighted 1x, price-sensitive news 5x, total news 1x.
    // News recency boost: most recent within 48h gets +2.
    const recencyBoost = news.some((a) => ageHoursOf(a) <= 48) ? 2 : 0;
    const score =
      shortPct + priceSensitive * 5 + news.length + recencyBoost;

    const top = news[0]!;
    candidates.push({
      stockCode: code,
      name: stock.name,
      shortPct,
      recentNews: news,
      priceSensitiveCount: priceSensitive,
      topHeadline: top.headline,
      topSource: top.source,
      topSentiment: top.sentiment,
      score,
      rationale: [
        `${shortPct.toFixed(2)}% shorted`,
        `${news.length} news article(s) in last ${Math.round(cfg.newsWindowHours / 24)}d`,
        priceSensitive > 0 ? `${priceSensitive} price-sensitive` : "",
        recencyBoost ? "fresh news (≤48h)" : "",
      ]
        .filter(Boolean)
        .join(" · "),
    });
  }

  // Highest score first.
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, cfg.topN);
}
