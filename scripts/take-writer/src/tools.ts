// Gemini function-call declarations for the investigation agent. Each
// wraps a drill-down query. dispatchTool registers every source the tool
// surfaces into the citation ledger (handing back stable refIds) so the
// writer can cite only what was actually retrieved.

import { SchemaType, type FunctionDeclaration } from "@google/generative-ai";
import type { CitationLedger, LedgerSource } from "./ledger.js";
import {
  zoomWindow, reportLine, followPeer, alignEvents, newsDetail, searchNews, getOverview, getFinancials,
  type Queryable,
} from "./drilldowns.js";

export const GEMINI_TOOL_DECLS: FunctionDeclaration[] = [
  {
    name: "get_overview",
    description: "Big-picture short-position signals for the subject stock in ONE call: current short %, 90d avg + change, 7/30/90-day slope, price changes (1m/3m/6m/12m), 30-day price-shorts correlation, news/sentiment counts, director net trade value (AUD), and sector-peer comparison. CALL THIS FIRST to orient. These are Shorted's OWN computed numbers — state them in prose WITHOUT a [ref-N] citation.",
    parameters: { type: SchemaType.OBJECT, properties: {} },
  },
  {
    name: "zoom_window",
    description: "Zoom into the short %, price, and news in a +/- day window around a specific date — use to investigate a spike or a price move you noticed in the summary.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        date: { type: SchemaType.STRING, description: "Centre date YYYY-MM-DD" },
        days: { type: SchemaType.NUMBER, description: "Half-window in days (e.g. 3)" },
      },
      required: ["date"],
    },
  },
  {
    name: "report_line",
    description: "Pull one reported financial metric (revenue, ebitda, eps, dividend, guidance, cash_flow, net_profit) from the company's most recent filings. Returns the value and a citable source.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: { metric: { type: SchemaType.STRING, description: "Metric key, e.g. 'revenue'" } },
      required: ["metric"],
    },
  },
  {
    name: "follow_peer",
    description: "Pull a named sector peer's short %/price history to compare divergence against the subject stock.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: { peerCode: { type: SchemaType.STRING }, days: { type: SchemaType.NUMBER } },
      required: ["peerCode"],
    },
  },
  {
    name: "align_events",
    description: "Return a merged timeline of director trades and price-sensitive news for the subject, newest first — use to align director activity against price/short moves.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: { days: { type: SchemaType.NUMBER } },
    },
  },
  {
    name: "news_detail",
    description: "Fetch the full record (summary, sentiment, url) for one news article by its id.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: { articleId: { type: SchemaType.STRING } },
      required: ["articleId"],
    },
  },
  {
    name: "search_news",
    description: "Keyword-search recent news headlines/summaries (optionally scoped to a stock code) to find a specific thread.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: { query: { type: SchemaType.STRING }, code: { type: SchemaType.STRING } },
      required: ["query"],
    },
  },
  {
    name: "get_financials",
    description: "Pull the company's last few financial reports with their FULL metric sets (revenue, profit, eps, dividend, guidance, cash flow) in one call. Returns one citable source per report. PREFER this over report_line when building the financial picture; use report_line only for a targeted follow-up.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: { n: { type: SchemaType.NUMBER, description: "How many recent reports (default 4)" } },
    },
  },
];

/** Register a source and return "[refId] headline (source, date)" for the agent. */
function cite(ledger: CitationLedger, s: LedgerSource): string {
  const refId = ledger.register(s);
  return `[${refId}] ${s.headline} (${s.source}, ${s.date})`;
}

export async function dispatchTool(
  pg: Queryable,
  ledger: CitationLedger,
  name: string,
  input: Record<string, unknown>,
  subjectCode?: string,
): Promise<string> {
  try {
    switch (name) {
      case "get_overview": {
        const code = subjectCode ?? String(input.code ?? "");
        const ov = await getOverview(pg, code);
        return JSON.stringify(ov);
      }
      case "zoom_window": {
        const code = subjectCode ?? String(input.code ?? "");
        const w = await zoomWindow(pg, code, String(input.date), Number(input.days ?? 3));
        const newsLines = w.news.map((n) => cite(ledger, { type: "news", url: n.url, source: n.source, headline: n.headline, date: n.date }));
        return JSON.stringify({
          shorts: w.shorts, prices: w.prices,
          news: newsLines,
        });
      }
      case "report_line": {
        const code = subjectCode ?? String(input.code ?? "");
        const r = await reportLine(pg, code, String(input.metric));
        if (!r) return JSON.stringify({ found: false });
        const ref = cite(ledger, r.source);
        return JSON.stringify({ found: true, value: r.value, reportType: r.reportType, date: r.reportDate, citation: ref });
      }
      case "follow_peer": {
        const r = await followPeer(pg, String(input.peerCode), Number(input.days ?? 180));
        return JSON.stringify(r);
      }
      case "align_events": {
        const code = subjectCode ?? String(input.code ?? "");
        const items = await alignEvents(pg, code, Number(input.days ?? 180));
        return JSON.stringify(items.map((it) => ({ date: it.date, kind: it.kind, detail: it.detail, citation: cite(ledger, it.source) })));
      }
      case "news_detail": {
        const r = await newsDetail(pg, String(input.articleId));
        if (!r) return JSON.stringify({ found: false });
        const ref = cite(ledger, r.ledgerSource);
        return JSON.stringify({ found: true, headline: r.headline, summary: r.summary, sentiment: r.sentiment, date: r.date, citation: ref });
      }
      case "search_news": {
        const items = await searchNews(pg, String(input.query), input.code ? String(input.code) : subjectCode);
        return JSON.stringify(items.map((it) => ({ id: it.id, citation: cite(ledger, it.ledgerSource) })));
      }
      case "get_financials": {
        const code = subjectCode ?? String(input.code ?? "");
        const reports = await getFinancials(pg, code, Number(input.n ?? 4));
        return JSON.stringify(reports.map((r) => ({ reportType: r.reportType, date: r.reportDate, metrics: r.metrics, citation: cite(ledger, r.source) })));
      }
      default:
        return `ERROR: unknown tool "${name}"`;
    }
  } catch (err) {
    return `ERROR running ${name}: ${String((err as Error).message ?? err).slice(0, 200)}`;
  }
}
