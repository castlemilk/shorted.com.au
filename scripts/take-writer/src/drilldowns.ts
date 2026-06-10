// Incremental drill-down queries used by the investigation agent's
// tools. Each zooms into a slice of the data the agent already has a
// summary of — a window around a date, one peer, one report line — so
// the loop stays cheap instead of re-sending 365-day series each turn.

import type { LedgerSource } from "./ledger.js";

/** Minimal slice of pg.Client we need — lets tests inject a fake. */
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

export interface WindowResult {
  shorts: Array<{ date: string; pct: number }>;
  prices: Array<{ date: string; close: number; volume: number }>;
  news: Array<{ id: string; date: string; source: string; headline: string; url: string; sentiment: string | null }>;
}

export async function zoomWindow(
  pg: Queryable,
  code: string,
  date: string,
  days: number,
): Promise<WindowResult> {
  const lo = `${date} -${days} days`;
  const hi = `${date} +${days} days`;
  const shortsQ = pg.query(
    `SELECT to_char("DATE",'YYYY-MM-DD') AS date,
            "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" AS pct
     FROM shorts
     WHERE "PRODUCT_CODE"=$1 AND "DATE" BETWEEN $2::timestamp AND $3::timestamp
     ORDER BY "DATE" ASC`,
    [code, lo, hi],
  );
  const pricesQ = pg.query(
    `SELECT to_char(date,'YYYY-MM-DD') AS date, close, volume
     FROM stock_prices
     WHERE stock_code=$1 AND date BETWEEN $2::date AND $3::date
     ORDER BY date ASC`,
    [code, lo, hi],
  );
  const newsQ = pg.query(
    `SELECT id::text, to_char(published_at,'YYYY-MM-DD') AS date, source, headline, url, sentiment
     FROM news_articles
     WHERE stock_code=$1 AND published_at BETWEEN $2::timestamp AND $3::timestamp
       AND (cluster_id IS NULL OR cluster_is_primary = TRUE)
     ORDER BY published_at ASC LIMIT 40`,
    [code, lo, hi],
  );
  const [s, p, n] = await Promise.all([shortsQ, pricesQ, newsQ]);
  return {
    shorts: (s.rows as Array<{ date: string; pct: string }>).map((r) => ({ date: r.date, pct: Number(r.pct) })),
    prices: (p.rows as Array<{ date: string; close: string; volume: string }>).map((r) => ({ date: r.date, close: Number(r.close), volume: Number(r.volume) })),
    news: n.rows as WindowResult["news"],
  };
}

export interface ReportLineResult {
  value: string;
  reportType: string | null;
  reportDate: string | null;
  source: LedgerSource;
}

export async function reportLine(
  pg: Queryable,
  code: string,
  metric: string,
): Promise<ReportLineResult | null> {
  const { rows } = await pg.query(
    `SELECT report_url, report_type, report_title,
            to_char(report_date,'YYYY-MM-DD') AS report_date, metrics
     FROM financial_report_extractions
     WHERE stock_code=$1
     ORDER BY report_date DESC NULLS LAST, extracted_at DESC
     LIMIT 6`,
    [code],
  );
  for (const r of rows as Array<{ report_url: string; report_type: string | null; report_title: string | null; report_date: string | null; metrics: Record<string, unknown> | null }>) {
    const m = r.metrics ?? {};
    if (metric in m && m[metric] != null) {
      return {
        value: String(m[metric]),
        reportType: r.report_type,
        reportDate: r.report_date,
        source: {
          type: "report",
          url: r.report_url,
          source: r.report_type ?? "report",
          headline: r.report_title ?? "(financial report)",
          date: r.report_date ?? "",
        },
      };
    }
  }
  return null;
}

export interface FinancialReport {
  reportType: string | null;
  reportDate: string | null;
  title: string | null;
  metrics: Record<string, string>;
  source: LedgerSource;
}

/** Full key-metric sets for the last n filings in one call (vs report_line's
 *  one metric per call) so dossiers reliably carry the financial trajectory. */
export async function getFinancials(pg: Queryable, code: string, n = 4): Promise<FinancialReport[]> {
  n = Math.max(1, Math.min(n, 20));
  const { rows } = await pg.query(
    `SELECT report_url, report_type, report_title,
            to_char(report_date,'YYYY-MM-DD') AS report_date, metrics
     FROM financial_report_extractions
     WHERE stock_code=$1
     ORDER BY report_date DESC NULLS LAST, extracted_at DESC
     LIMIT $2`,
    [code, n],
  );
  return (rows as Array<{ report_url: string; report_type: string | null; report_title: string | null; report_date: string | null; metrics: Record<string, unknown> | null }>)
    .map((r) => ({
      reportType: r.report_type,
      reportDate: r.report_date,
      title: r.report_title,
      metrics: Object.fromEntries(
        Object.entries(r.metrics ?? {})
          .filter(([, v]) => v != null)
          .map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : String(v)]),
      ),
      source: {
        type: "report",
        url: r.report_url,
        source: r.report_type ?? "report",
        headline: r.report_title ?? "(financial report)",
        date: r.report_date ?? "",
      } as LedgerSource,
    }));
}

export interface FollowPeerResult {
  shorts: Array<{ date: string; pct: number }>;
  prices: Array<{ date: string; close: number }>;
}

export async function followPeer(
  pg: Queryable,
  peerCode: string,
  days = 180,
): Promise<FollowPeerResult> {
  const sQ = pg.query(
    `SELECT to_char("DATE",'YYYY-MM-DD') AS date,
            "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" AS pct
     FROM shorts WHERE "PRODUCT_CODE"=$1 AND "DATE" > NOW() - $2::interval ORDER BY "DATE" ASC`,
    [peerCode, `${days} days`],
  );
  const pQ = pg.query(
    `SELECT to_char(date,'YYYY-MM-DD') AS date, close FROM stock_prices
     WHERE stock_code=$1 AND date > NOW() - $2::interval ORDER BY date ASC`,
    [peerCode, `${days} days`],
  );
  const [s, p] = await Promise.all([sQ, pQ]);
  return {
    shorts: (s.rows as Array<{ date: string; pct: string }>).map((r) => ({ date: r.date, pct: Number(r.pct) })),
    prices: (p.rows as Array<{ date: string; close: string }>).map((r) => ({ date: r.date, close: Number(r.close) })),
  };
}

export interface AlignEventsItem {
  date: string;
  kind: "director_trade" | "news";
  detail: string;
  source: LedgerSource;
}

export async function alignEvents(
  pg: Queryable,
  code: string,
  days = 180,
): Promise<AlignEventsItem[]> {
  const tradesQ = pg.query(
    `SELECT to_char(trade_date,'YYYY-MM-DD') AS date, director_name, trade_type,
            total_value, announcement_url
     FROM director_trades WHERE stock_code=$1 AND trade_date > NOW() - $2::interval
     ORDER BY trade_date DESC LIMIT 50`,
    [code, `${days} days`],
  );
  const newsQ = pg.query(
    `SELECT id::text, to_char(published_at,'YYYY-MM-DD') AS date, source, headline, url
     FROM news_articles WHERE stock_code=$1 AND is_price_sensitive=true
       AND published_at > NOW() - $2::interval
       AND (cluster_id IS NULL OR cluster_is_primary = TRUE)
     ORDER BY published_at DESC LIMIT 40`,
    [code, `${days} days`],
  );
  const [t, n] = await Promise.all([tradesQ, newsQ]);
  const out: AlignEventsItem[] = [];
  for (const r of t.rows as Array<{ date: string; director_name: string; trade_type: string; total_value: string | null; announcement_url: string | null }>) {
    out.push({
      date: r.date,
      kind: "director_trade",
      detail: `${r.director_name} ${r.trade_type}${r.total_value ? ` A$${r.total_value}` : ""}`,
      source: { type: "director", url: r.announcement_url ?? "", source: "director trade", headline: `${r.director_name} ${r.trade_type}`, date: r.date },
    });
  }
  for (const r of n.rows as Array<{ id: string; date: string; source: string; headline: string; url: string }>) {
    out.push({ date: r.date, kind: "news", detail: r.headline, source: { type: "news", url: r.url, source: r.source, headline: r.headline, date: r.date } });
  }
  out.sort((a, b) => (a.date < b.date ? 1 : -1));
  return out;
}

export interface NewsDetailResult {
  id: string; date: string; source: string; headline: string; url: string;
  sentiment: string | null; summary: string | null; ledgerSource: LedgerSource;
}

export async function newsDetail(pg: Queryable, articleId: string): Promise<NewsDetailResult | null> {
  const { rows } = await pg.query(
    `SELECT id::text, to_char(published_at,'YYYY-MM-DD') AS date, source, headline, url, sentiment, summary
     FROM news_articles WHERE id=$1::uuid LIMIT 1`,
    [articleId],
  );
  const r = (rows as Array<{ id: string; date: string; source: string; headline: string; url: string; sentiment: string | null; summary: string | null }>)[0];
  if (!r) return null;
  return { ...r, ledgerSource: { type: "news", url: r.url, source: r.source, headline: r.headline, date: r.date } };
}

export interface SearchNewsItem {
  id: string; date: string; source: string; headline: string; url: string; ledgerSource: LedgerSource;
}

export async function searchNews(pg: Queryable, query: string, code?: string): Promise<SearchNewsItem[]> {
  const params: unknown[] = [`%${query}%`];
  let codeClause = "";
  if (code) { params.push(code); codeClause = `AND stock_code=$${params.length}`; }
  const { rows } = await pg.query(
    `SELECT id::text, to_char(published_at,'YYYY-MM-DD') AS date, source, headline, url
     FROM news_articles
     WHERE (headline ILIKE $1 OR summary ILIKE $1) ${codeClause}
       AND (cluster_id IS NULL OR cluster_is_primary = TRUE)
     ORDER BY published_at DESC LIMIT 25`,
    params,
  );
  return (rows as Array<{ id: string; date: string; source: string; headline: string; url: string }>).map((r) => ({
    ...r, ledgerSource: { type: "news", url: r.url, source: r.source, headline: r.headline, date: r.date },
  }));
}

// --- overview (big-picture signals in one call; mirrors journalism.ts math) ---
function ov_slope(values: number[]): number | null {
  if (values.length < 2) return null;
  const n = values.length, xMean = (n - 1) / 2;
  const yMean = values.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (i - xMean) * (values[i]! - yMean); den += (i - xMean) ** 2; }
  return den === 0 ? 0 : num / den;
}
function ov_pctChange(series: number[], lookback: number): number | null {
  if (series.length < lookback + 1) return null;
  const recent = series[series.length - 1]!, past = series[series.length - 1 - lookback]!;
  if (past === 0) return null;
  return ((recent - past) / past) * 100;
}
function ov_pearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]!; sy += ys[i]!; }
  const mx = sx / n, my = sy / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const ex = xs[i]! - mx, ey = ys[i]! - my; num += ex * ey; dx += ex * ex; dy += ey * ey; }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

export interface OverviewResult {
  currentShortPct: number | null; shortPct90dAvg: number | null; shortPctChange90d: number | null;
  shortPctMaxIn90d: number | null;
  shortSlope7d: number | null; shortSlope30d: number | null; shortSlope90d: number | null;
  currentPrice: number | null;
  priceChange1m: number | null; priceChange3m: number | null; priceChange6m: number | null; priceChange12m: number | null;
  priceShortsCorrelation30d: number | null;
  newsLast30d: number; newsLast7d: number; priceSensitiveLast30d: number;
  sentiment: { positive: number; negative: number; neutral: number };
  directorNetValue90d: number;
  peerSectorAvgShort: number | null; peerRelative: "above" | "below" | "at" | "n/a";
  peers: Array<{ code: string; pct: number }>;
}

/** One-call big-picture signals for the subject stock. These are Shorted's
 *  OWN computed numbers (not citable news) — no ledger registration. */
export async function getOverview(pg: Queryable, code: string): Promise<OverviewResult> {
  const shortsR = await pg.query(
    `SELECT to_char("DATE",'YYYY-MM-DD') AS date, "PERCENT_OF_TOTAL_PRODUCT_IN_ISSUE_REPORTED_AS_SHORT_POSITIONS" AS pct
     FROM shorts WHERE "PRODUCT_CODE"=$1 AND "DATE" > NOW() - interval '365 days' ORDER BY "DATE" ASC`, [code]);
  const shorts = (shortsR.rows as Array<{ date: string; pct: string }>).map((r) => ({ date: r.date, pct: Number(r.pct) }));
  const pricesR = await pg.query(
    `SELECT to_char(date,'YYYY-MM-DD') AS date, close FROM stock_prices
     WHERE stock_code=$1 AND date > NOW() - interval '365 days' ORDER BY date ASC`, [code]);
  const prices = (pricesR.rows as Array<{ date: string; close: string }>).map((r) => ({ date: r.date, close: Number(r.close) }));
  const newsR = await pg.query(
    `SELECT to_char(published_at,'YYYY-MM-DD') AS date, sentiment, is_price_sensitive
     FROM news_articles WHERE stock_code=$1 AND published_at > NOW() - interval '30 days'`, [code]);
  const news = newsR.rows as Array<{ date: string; sentiment: string | null; is_price_sensitive: boolean }>;
  const dirR = await pg.query(
    `SELECT trade_type, total_value FROM director_trades WHERE stock_code=$1 AND trade_date > NOW() - interval '90 days'`, [code]);
  const dirs = dirR.rows as Array<{ trade_type: string; total_value: string | null }>;
  const peersR = await pg.query(
    `SELECT cm.stock_code AS code, mv.current_percent AS pct FROM mv_top_shorts mv
     JOIN "company-metadata" cm ON cm.stock_code = mv.product_code
     WHERE cm.industry = (SELECT industry FROM "company-metadata" WHERE stock_code=$1) AND mv.product_code <> $1
     ORDER BY mv.current_percent DESC LIMIT 8`, [code]);
  const peers = (peersR.rows as Array<{ code: string; pct: string }>).map((r) => ({ code: r.code, pct: Number(r.pct) }));

  const sp = shorts.map((s) => s.pct);
  const last90 = sp.slice(-90), last30 = sp.slice(-30), last7 = sp.slice(-7);
  const currentShortPct = sp.length ? sp[sp.length - 1]! : null;
  const shortPct90dAvg = last90.length ? last90.reduce((a, b) => a + b, 0) / last90.length : null;
  const closes = prices.map((p) => p.close);
  const priceByDate = new Map(prices.map((p) => [p.date, p.close]));
  const pairs: Array<[number, number]> = [];
  for (let i = 1; i < shorts.length; i++) {
    const c = priceByDate.get(shorts[i]!.date), pv = priceByDate.get(shorts[i - 1]!.date);
    if (c && pv) pairs.push([c - pv, shorts[i]!.pct - shorts[i - 1]!.pct]);
  }
  const recent = pairs.slice(-30);
  const corr = recent.length >= 3 ? ov_pearson(recent.map((p) => p[0]), recent.map((p) => p[1])) : null;
  const sentiment = { positive: 0, negative: 0, neutral: 0 };
  for (const a of news) { if (a.sentiment === "positive") sentiment.positive++; else if (a.sentiment === "negative") sentiment.negative++; else sentiment.neutral++; }
  const now = Date.now(), day = 86400000;
  const newsLast7d = news.filter((a) => now - new Date(a.date).getTime() <= 7 * day).length;
  const directorNetValue90d = dirs.reduce((acc, t) => { const v = t.total_value ? Number(t.total_value) : 0; return acc + (t.trade_type.toLowerCase() === "buy" ? v : -v); }, 0);
  const peerSectorAvgShort = peers.length ? peers.reduce((a, p) => a + p.pct, 0) / peers.length : null;
  let peerRelative: OverviewResult["peerRelative"] = "n/a";
  if (peerSectorAvgShort !== null && currentShortPct !== null) { const d = currentShortPct - peerSectorAvgShort; peerRelative = Math.abs(d) < 1 ? "at" : d > 0 ? "above" : "below"; }

  return {
    currentShortPct, shortPct90dAvg,
    shortPctChange90d: currentShortPct !== null && shortPct90dAvg !== null ? currentShortPct - shortPct90dAvg : null,
    shortPctMaxIn90d: last90.length ? Math.max(...last90) : null,
    shortSlope7d: ov_slope(last7), shortSlope30d: ov_slope(last30), shortSlope90d: ov_slope(last90),
    currentPrice: closes.length ? closes[closes.length - 1]! : null,
    priceChange1m: ov_pctChange(closes, 22), priceChange3m: ov_pctChange(closes, 66),
    priceChange6m: ov_pctChange(closes, 132), priceChange12m: ov_pctChange(closes, 252),
    priceShortsCorrelation30d: corr,
    newsLast30d: news.length, newsLast7d, priceSensitiveLast30d: news.filter((a) => a.is_price_sensitive).length,
    sentiment, directorNetValue90d, peerSectorAvgShort, peerRelative, peers,
  };
}
