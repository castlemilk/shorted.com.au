// Journalism engine — chunk A: data aggregation + signal extraction.
//
// Given a stock code, pull a dense bundle from the production DB:
//   - Short-position time series (last 365d)
//   - Daily prices (last 365d)
//   - News articles mentioning the stock or its sector (last 90d)
//   - Director trades (last 180d)
//   - Peer comparison (sector neighbours by short %)
//   - Company metadata (name, industry, market cap, summary)
//
// Then compute non-LLM signals:
//   - short trend slopes (90d / 30d / 7d)
//   - short position change vs 90d average
//   - price change windows (1m / 3m / 6m / 12m)
//   - price-shorts correlation
//   - news density (articles per week vs baseline)
//   - sentiment trend over time
//   - director-trade summary (net $, count, recency)
//   - peer relative position
//   - notable events (top 3 most recent price-sensitive items)
//
// asx_announcements is currently empty in prod (collector not running) —
// included as a stub for when it comes online.

import { Client as PgClient } from "pg";

// --- Types ---

export interface ShortPoint {
  date: string;   // YYYY-MM-DD
  pct: number;
}

export interface PricePoint {
  date: string;
  close: number;
  volume: number;
}

export interface NewsArticle {
  id: string;
  publishedAt: string;
  source: string;
  headline: string;
  url: string;
  sentiment: string | null;
  isPriceSensitive: boolean;
  summary: string | null;
}

export interface DirectorTradeRow {
  tradeDate: string;
  directorName: string;
  tradeType: string;
  sharesTraded: number | null;
  totalValue: number | null;
  announcementUrl: string | null;
}

export interface PeerRow {
  code: string;
  name: string;
  currentPct: number;
}

export interface CompanyMeta {
  stockCode: string;
  name: string | null;
  sector: string | null;
  industry: string | null;
  marketCap: number | null;
  description: string | null;
  website: string | null;
}

export interface FinancialReportRow {
  reportUrl: string;
  reportType: string | null;   // annual_results, half_year_results, quarterly_report, etc.
  reportTitle: string | null;
  reportDate: string | null;   // YYYY-MM-DD
  metrics: Record<string, unknown>;  // jsonb — keys like revenue, ebitda, eps, dividend, guidance, cash_flow, net_profit
}

export interface DataBundle {
  meta: CompanyMeta;
  shorts: ShortPoint[];
  prices: PricePoint[];
  news: NewsArticle[];
  directorTrades: DirectorTradeRow[];
  peers: PeerRow[];
  reports: FinancialReportRow[];
}

export interface Signals {
  // Short trends — slope of percentage_shorted over time, %/day.
  shortSlope90d: number | null;
  shortSlope30d: number | null;
  shortSlope7d: number | null;
  currentShortPct: number | null;
  shortPct90dAvg: number | null;
  shortPctChange90d: number | null;   // current - 90d avg
  shortPctMaxIn90d: number | null;
  shortPctMinIn90d: number | null;

  // Prices.
  currentPrice: number | null;
  priceChange1m: number | null;
  priceChange3m: number | null;
  priceChange6m: number | null;
  priceChange12m: number | null;

  // Correlation: rolling 30d Pearson(price_change, short_change). Useful
  // for distinguishing "shorts driving the price down" vs "shorts piling
  // in after a drop".
  priceShortsCorrelation30d: number | null;

  // News.
  newsArticlesLast30d: number;
  newsArticlesLast7d: number;
  priceSensitiveLast30d: number;
  sentimentMix: { positive: number; negative: number; neutral: number };
  sentimentTrendLast30d: "improving" | "deteriorating" | "stable" | "n/a";

  // Director activity.
  directorTradesLast90d: number;
  directorNetValueLast90d: number;   // buys - sells (AUD)
  directorMostRecentDate: string | null;

  // Peer context.
  peerSectorAverageShort: number | null;
  peerRelative: "above" | "below" | "at" | "n/a";

  // Notable events (most recent price-sensitive items).
  topRecentEvents: Array<{ date: string; source: string; headline: string; url: string; sentiment: string | null }>;
}

// --- Aggregation ---

async function fetchMeta(pg: PgClient, code: string): Promise<CompanyMeta> {
  const { rows } = await pg.query<{
    stock_code: string;
    company_name: string | null;
    industry: string | null;
    market_cap: string | null;
    summary: string | null;
    website: string | null;
  }>(
    // company-metadata has industry but no sector; market_cap is text.
    `SELECT stock_code, company_name, industry, market_cap, summary, website
     FROM "company-metadata"
     WHERE stock_code = $1`, [code],
  );
  const row = rows[0];
  const mcap = row?.market_cap ? Number(row.market_cap.replace(/[^0-9.-]/g, "")) : null;
  return {
    stockCode: code,
    name: row?.company_name ?? null,
    sector: row?.industry ?? null, // proxy — schema doesn't separate them
    industry: row?.industry ?? null,
    marketCap: Number.isFinite(mcap) ? mcap : null,
    description: row?.summary ?? null,
    website: row?.website ?? null,
  };
}

async function fetchShorts(pg: PgClient, code: string, days = 365): Promise<ShortPoint[]> {
  const { rows } = await pg.query<{ date: string; pct: number }>(
    `SELECT
       to_char("DATE", 'YYYY-MM-DD') AS date,
       "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" AS pct
     FROM shorts
     WHERE "PRODUCT_CODE" = $1 AND "DATE" > NOW() - $2::interval
     ORDER BY "DATE" ASC`,
    [code, `${days} days`],
  );
  return rows.map((r) => ({ date: r.date, pct: Number(r.pct) }));
}

async function fetchPrices(pg: PgClient, code: string, days = 365): Promise<PricePoint[]> {
  const { rows } = await pg.query<{ date: string; close: number; volume: number }>(
    `SELECT to_char(date, 'YYYY-MM-DD') AS date, close, volume
     FROM stock_prices
     WHERE stock_code = $1 AND date > NOW() - $2::interval
     ORDER BY date ASC`,
    [code, `${days} days`],
  );
  return rows.map((r) => ({
    date: r.date,
    close: Number(r.close),
    volume: Number(r.volume),
  }));
}

async function fetchNews(
  pg: PgClient,
  code: string,
  companyName: string | null,
  days = 90,
): Promise<NewsArticle[]> {
  // Match by stock_code OR headline OR summary mention of the ticker
  // OR substring of the company name (e.g. "DroneShield" for DRO).
  const nameLike = companyName
    ? companyName.split(/\s+/).filter((w) => w.length > 4).slice(0, 1)[0]
    : null;
  const { rows } = await pg.query<{
    id: string;
    published_at: string;
    source: string;
    headline: string;
    url: string;
    sentiment: string | null;
    is_price_sensitive: boolean;
    summary: string | null;
  }>(
    `SELECT id::text, to_char(published_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS published_at,
            source, headline, url, sentiment, is_price_sensitive, summary
     FROM news_articles
     WHERE published_at > NOW() - $1::interval
       AND (
         stock_code = $2
         OR headline ~* ('\\m' || $2 || '\\M')
         OR ($3::text IS NOT NULL AND headline ILIKE '%' || $3 || '%')
         OR ($3::text IS NOT NULL AND summary ILIKE '%' || $3 || '%')
       )
     ORDER BY published_at DESC
     LIMIT 200`,
    [`${days} days`, code, nameLike],
  );
  return rows.map((r) => ({
    id: r.id,
    publishedAt: r.published_at,
    source: r.source,
    headline: r.headline,
    url: r.url,
    sentiment: r.sentiment,
    isPriceSensitive: r.is_price_sensitive,
    summary: r.summary,
  }));
}

async function fetchDirectorTrades(pg: PgClient, code: string, days = 180): Promise<DirectorTradeRow[]> {
  const { rows } = await pg.query<{
    trade_date: string;
    director_name: string;
    trade_type: string;
    shares_traded: number | null;
    total_value: number | null;
    announcement_url: string | null;
  }>(
    `SELECT to_char(trade_date, 'YYYY-MM-DD') AS trade_date,
            director_name, trade_type, shares_traded, total_value, announcement_url
     FROM director_trades
     WHERE stock_code = $1 AND trade_date > NOW() - $2::interval
     ORDER BY trade_date DESC
     LIMIT 50`,
    [code, `${days} days`],
  );
  return rows.map((r) => ({
    tradeDate: r.trade_date,
    directorName: r.director_name,
    tradeType: r.trade_type,
    sharesTraded: r.shares_traded != null ? Number(r.shares_traded) : null,
    totalValue: r.total_value != null ? Number(r.total_value) : null,
    announcementUrl: r.announcement_url,
  }));
}

async function fetchPeers(pg: PgClient, code: string, industry: string | null): Promise<PeerRow[]> {
  if (!industry) return [];
  const { rows } = await pg.query<{ stock_code: string; company_name: string; pct: number }>(
    `SELECT cm.stock_code, cm.company_name, mv.current_percent AS pct
     FROM mv_top_shorts mv
     JOIN "company-metadata" cm ON cm.stock_code = mv.product_code
     WHERE cm.industry = $1 AND mv.product_code <> $2
     ORDER BY mv.current_percent DESC
     LIMIT 8`,
    [industry, code],
  );
  return rows.map((r) => ({
    code: r.stock_code,
    name: r.company_name,
    currentPct: Number(r.pct),
  }));
}

async function fetchReports(pg: PgClient, code: string, limit = 6): Promise<FinancialReportRow[]> {
  const { rows } = await pg.query<{
    report_url: string;
    report_type: string | null;
    report_title: string | null;
    report_date: string | null;
    metrics: Record<string, unknown> | null;
  }>(
    `SELECT report_url, report_type, report_title,
            to_char(report_date, 'YYYY-MM-DD') AS report_date,
            metrics
     FROM financial_report_extractions
     WHERE stock_code = $1
     ORDER BY report_date DESC NULLS LAST, extracted_at DESC
     LIMIT $2`,
    [code, limit],
  );
  return rows.map((r) => ({
    reportUrl: r.report_url,
    reportType: r.report_type,
    reportTitle: r.report_title,
    reportDate: r.report_date,
    metrics: r.metrics ?? {},
  }));
}

export async function aggregate(
  pg: PgClient,
  code: string,
): Promise<DataBundle> {
  const meta = await fetchMeta(pg, code);
  const [shorts, prices, news, directorTrades, peers, reports] = await Promise.all([
    fetchShorts(pg, code, 365),
    fetchPrices(pg, code, 365),
    fetchNews(pg, code, meta.name, 90),
    fetchDirectorTrades(pg, code, 180),
    fetchPeers(pg, code, meta.industry),
    fetchReports(pg, code, 6),
  ]);
  return { meta, shorts, prices, news, directorTrades, peers, reports };
}

// --- Signals ---

/** Simple linear regression slope of y over x indexes. */
function slope(values: number[]): number | null {
  if (values.length < 2) return null;
  const n = values.length;
  const xMean = (n - 1) / 2;
  const yMean = values.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (values[i]! - yMean);
    den += (i - xMean) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

function pearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]!; sy += ys[i]!; }
  const mx = sx / n, my = sy / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const ex = xs[i]! - mx;
    const ey = ys[i]! - my;
    num += ex * ey;
    dx += ex * ex;
    dy += ey * ey;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

function pctChange(series: number[], lookback: number): number | null {
  if (series.length < lookback + 1) return null;
  const recent = series[series.length - 1]!;
  const past = series[series.length - 1 - lookback]!;
  if (past === 0) return null;
  return ((recent - past) / past) * 100;
}

export function extractSignals(bundle: DataBundle): Signals {
  const shortPcts = bundle.shorts.map((s) => s.pct);
  const last7 = shortPcts.slice(-7);
  const last30 = shortPcts.slice(-30);
  const last90 = shortPcts.slice(-90);
  const currentShortPct = shortPcts.length ? shortPcts[shortPcts.length - 1]! : null;
  const shortPct90dAvg = last90.length ? last90.reduce((a, b) => a + b, 0) / last90.length : null;

  const closes = bundle.prices.map((p) => p.close);

  // Align prices and shorts on dates for correlation.
  const priceByDate = new Map(bundle.prices.map((p) => [p.date, p.close]));
  const pairedChanges: Array<[number, number]> = [];
  for (let i = 1; i < bundle.shorts.length; i++) {
    const dPrev = bundle.shorts[i - 1]!;
    const dCur = bundle.shorts[i]!;
    const priceCur = priceByDate.get(dCur.date);
    const pricePrev = priceByDate.get(dPrev.date);
    if (priceCur && pricePrev) {
      pairedChanges.push([priceCur - pricePrev, dCur.pct - dPrev.pct]);
    }
  }
  const recentPairs = pairedChanges.slice(-30);
  const priceShortsCorrelation30d = recentPairs.length >= 3
    ? pearson(recentPairs.map((p) => p[0]), recentPairs.map((p) => p[1]))
    : null;

  // News.
  const now = Date.now();
  const day = 86400000;
  const newsLast30 = bundle.news.filter((a) => now - new Date(a.publishedAt).getTime() <= 30 * day);
  const newsLast7 = bundle.news.filter((a) => now - new Date(a.publishedAt).getTime() <= 7 * day);
  const priceSensitiveLast30d = newsLast30.filter((a) => a.isPriceSensitive).length;
  const sentimentMix = { positive: 0, negative: 0, neutral: 0 };
  for (const a of newsLast30) {
    if (a.sentiment === "positive") sentimentMix.positive++;
    else if (a.sentiment === "negative") sentimentMix.negative++;
    else sentimentMix.neutral++;
  }
  let sentimentTrendLast30d: Signals["sentimentTrendLast30d"] = "n/a";
  if (newsLast30.length >= 5) {
    const half = Math.floor(newsLast30.length / 2);
    const olderHalf = newsLast30.slice(half);
    const newerHalf = newsLast30.slice(0, half);
    const score = (arr: NewsArticle[]) =>
      arr.reduce(
        (acc, a) =>
          acc + (a.sentiment === "positive" ? 1 : a.sentiment === "negative" ? -1 : 0),
        0,
      );
    const diff = score(newerHalf) - score(olderHalf);
    if (diff > 1) sentimentTrendLast30d = "improving";
    else if (diff < -1) sentimentTrendLast30d = "deteriorating";
    else sentimentTrendLast30d = "stable";
  }

  // Director trades.
  const directorsLast90 = bundle.directorTrades.filter(
    (t) => now - new Date(t.tradeDate).getTime() <= 90 * day,
  );
  const directorNetValueLast90d = directorsLast90.reduce((acc, t) => {
    const v = t.totalValue ?? 0;
    return acc + (t.tradeType.toLowerCase() === "buy" ? v : -v);
  }, 0);

  // Peer.
  const peerSectorAverageShort = bundle.peers.length
    ? bundle.peers.reduce((a, p) => a + p.currentPct, 0) / bundle.peers.length
    : null;
  let peerRelative: Signals["peerRelative"] = "n/a";
  if (peerSectorAverageShort !== null && currentShortPct !== null) {
    const diff = currentShortPct - peerSectorAverageShort;
    peerRelative = Math.abs(diff) < 1 ? "at" : diff > 0 ? "above" : "below";
  }

  // Notable events: most recent price-sensitive items.
  const topRecentEvents = bundle.news
    .filter((a) => a.isPriceSensitive)
    .slice(0, 3)
    .map((a) => ({
      date: a.publishedAt.slice(0, 10),
      source: a.source,
      headline: a.headline,
      url: a.url,
      sentiment: a.sentiment,
    }));

  return {
    shortSlope90d: slope(last90),
    shortSlope30d: slope(last30),
    shortSlope7d: slope(last7),
    currentShortPct,
    shortPct90dAvg,
    shortPctChange90d:
      currentShortPct !== null && shortPct90dAvg !== null
        ? currentShortPct - shortPct90dAvg
        : null,
    shortPctMaxIn90d: last90.length ? Math.max(...last90) : null,
    shortPctMinIn90d: last90.length ? Math.min(...last90) : null,

    currentPrice: closes.length ? closes[closes.length - 1]! : null,
    priceChange1m: pctChange(closes, 22),
    priceChange3m: pctChange(closes, 66),
    priceChange6m: pctChange(closes, 132),
    priceChange12m: pctChange(closes, 252),
    priceShortsCorrelation30d,

    newsArticlesLast30d: newsLast30.length,
    newsArticlesLast7d: newsLast7.length,
    priceSensitiveLast30d,
    sentimentMix,
    sentimentTrendLast30d,

    directorTradesLast90d: directorsLast90.length,
    directorNetValueLast90d,
    directorMostRecentDate: directorsLast90[0]?.tradeDate ?? null,

    peerSectorAverageShort,
    peerRelative,

    topRecentEvents,
  };
}

// --- CLI shape ---

export interface JournalismReport {
  bundle: DataBundle;
  signals: Signals;
}

export async function buildReport(
  pg: PgClient,
  code: string,
): Promise<JournalismReport> {
  const bundle = await aggregate(pg, code);
  const signals = extractSignals(bundle);
  return { bundle, signals };
}
