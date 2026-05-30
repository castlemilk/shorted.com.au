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
       AND published_at > NOW() - $2::interval ORDER BY published_at DESC LIMIT 40`,
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
     ORDER BY published_at DESC LIMIT 25`,
    params,
  );
  return (rows as Array<{ id: string; date: string; source: string; headline: string; url: string }>).map((r) => ({
    ...r, ledgerSource: { type: "news", url: r.url, source: r.source, headline: r.headline, date: r.date },
  }));
}
