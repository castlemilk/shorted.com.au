"use server";

/**
 * The insights explorer's data (/ownership/insights) as plain rows.
 *
 * The page calls loadOwnershipInsights({}) for its default render, and hands
 * the same action to its island, which asks again when the window or the focus
 * changes. One function serves both, so the two never draw different shapes.
 * The island asks for a part: "all" for the whole view, "sector" for a sector's
 * drill (its stocks, institutions and moves) and "stock" for a stock's panel.
 * The API answers the whole window either way and caches it; this action sends
 * the browser only the part asked for.
 *
 * NEVER THROWS, AND `ok` MEANS THE QUERY WAS SERVED, as ownershipExplorer.ts
 * says: a failed read is `ok: false` with an empty `error`; a refusal (the
 * clamp's or the API's InvalidArgument) is `ok: false` with its reason, logged;
 * an empty register is `ok: true` with no rows.
 *
 * KV ONLY FOR THE DEFAULT VIEW, under one versioned key, and only a populated
 * answer is kept. Every other window is a live read: the API's own window cache
 * is the dedupe.
 *
 * Server-side calls go through serverFetchWithUserAgent with the ownership ISR
 * tag, as ownership-shared.ts does. The route keeps its revalidate and tag, and
 * nothing is stored in Next's data cache.
 */

import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";

import {
  GetOwnershipInsightsResponseSchema,
  OwnershipInsightsService,
  type GetOwnershipInsightsResponse,
  type InsightFlow,
  type InsightStockDetail,
} from "~/gen/shorts/v1alpha1/ownership_insights_pb";
import type { SubstantialNotice } from "~/gen/shorts/v1alpha1/ownership_pb";
import { sectorLabel } from "~/@/lib/ownership/insights/format";
import { clampInsightsQuery, isDefaultInsightsQuery, type InsightsQueryInput } from "~/@/lib/ownership/insights/query";
import {
  EMPTY_FLOW,
  emptyInsightsPage,
  type InsightFlowRow,
  type InsightMoveRow,
  type InsightsPage,
  type InsightsPart,
  type InsightsQuery,
  type InsightStockDetailRow,
} from "~/@/lib/ownership/insights/types";
import { noticeRow } from "~/@/lib/ownership/rows";
import { CACHE_KEYS } from "@/lib/kv-cache";
import { SERVER_SHORTS_API_URL, serverFetchWithUserAgent, skipForBuild } from "./config";
import { cachedRead } from "./ownership-shared";
import { withRetryAndNotFound } from "./withRetry";

// ISR-tagged transport, as ownership-shared.ts's: without `next`, a POST at
// Vercel runtime is forced no-store and an ISR regeneration throws. The
// "ownership" tag is the one the ownership job's revalidate expires.
const isrInsightsFetch: typeof fetch = (input, init) =>
  serverFetchWithUserAgent(input, {
    ...init,
    next: { revalidate: 3600, tags: ["ownership"] },
  } as RequestInit);

function insightsClient() {
  return createClient(
    OwnershipInsightsService,
    createConnectTransport({ fetch: isrInsightsFetch, baseUrl: SERVER_SHORTS_API_URL }),
  );
}

type Asked = { kind: "answered"; response: GetOwnershipInsightsResponse } | { kind: "refused"; reason: string };

/** Connect's InvalidArgument (gRPC code 3). */
const CODE_INVALID_ARGUMENT = 3;

function refusalReason(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { code, rawMessage, message } = error as { code?: unknown; rawMessage?: unknown; message?: unknown };
  if (code !== CODE_INVALID_ARGUMENT) return undefined;
  if (typeof rawMessage === "string") return rawMessage;
  return typeof message === "string" ? message : "";
}

// withRetryAndNotFound answers undefined for every failure: this module's outage.
const requestInsights = withRetryAndNotFound(async (query: InsightsQuery): Promise<Asked> => {
  try {
    const response = await insightsClient().getOwnershipInsights({
      windowFrom: query.from,
      windowTo: query.to,
      sector: query.sector ?? "",
      stockCode: query.stock,
    });
    return { kind: "answered", response };
  } catch (error) {
    const reason = refusalReason(error);
    if (reason === undefined) throw error;
    return { kind: "refused", reason };
  }
});

const REFUSAL_LOG_CHARS = 200;

function logRefusal(reason: string): string {
  console.warn(`[ownership insights] refused query: ${reason.slice(0, REFUSAL_LOG_CHARS)}`);
  return reason;
}

/**
 * The insights for one query. `loadOwnershipInsights({})` is the default view:
 * the API's default window, no focus, the whole answer. Never throws.
 */
export async function loadOwnershipInsights(input: InsightsQueryInput = {}): Promise<InsightsPage> {
  const fallbackQuery: InsightsQuery = { from: "", to: "", sector: null, stock: "" };
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return emptyInsightsPage(fallbackQuery, "all", logRefusal("the query must be an object"));
  }
  const clamped = clampInsightsQuery(input);
  if (!clamped.ok) return emptyInsightsPage(fallbackQuery, "all", logRefusal(clamped.error));
  const { query, part } = clamped;
  if (skipForBuild()) return emptyInsightsPage(query, part);

  let asked: Asked | undefined;
  if (isDefaultInsightsQuery(query, part)) {
    let refusal: Asked | undefined;
    const answer = await cachedRead<GetOwnershipInsightsResponse>(
      CACHE_KEYS.ownershipInsights(),
      GetOwnershipInsightsResponseSchema,
      (v) => (v.window?.timelineTo ?? "") !== "" && v.sectors.length > 0,
      async () => {
        const result = await requestInsights(query);
        if (result?.kind === "refused") {
          refusal = result;
          return undefined;
        }
        return result?.response;
      },
    );
    asked = answer !== undefined ? { kind: "answered", response: answer } : refusal;
  } else {
    asked = await requestInsights(query);
  }
  if (asked?.kind === "refused") {
    return emptyInsightsPage(query, part, logRefusal(`refused by the API: ${asked.reason}`));
  }
  if (asked === undefined) return emptyInsightsPage(query, part);
  return mapInsights(query, part, asked.response);
}

function flowRow(flow: InsightFlow | undefined): InsightFlowRow {
  if (!flow) return EMPTY_FLOW;
  return {
    nodes: flow.nodes.map((n) => ({
      id: n.id,
      label: n.column === 2 && n.id !== "sector:other" ? sectorLabel(n.sector) : n.label,
      column: n.column,
      kind: n.kind,
      slug: n.slug,
      sector: n.sector,
      value: n.valueAud,
    })),
    links: flow.links.map((l) => ({ source: l.source, target: l.target, value: l.valueAud })),
    total: flow.totalAud,
    asAtFrom: flow.asAtFrom,
    asAtTo: flow.asAtTo,
  };
}

/** A notice's stated move, printed as the feed prints it (rows.ts's noticeRow). */
function moveRow(n: SubstantialNotice): InsightMoveRow {
  const row = noticeRow(n, true);
  return {
    code: n.stockCode,
    companyName: n.companyName,
    holder: row.holder?.name ?? "Unnamed holder",
    holderHref: row.holder?.href ?? null,
    kind: n.kind,
    event: n.event,
    date: n.eventDate || n.announcedOn,
    votingPower: row.votingPower,
    change: row.change,
    deltaPp: n.hasPresent && n.hasPrevious ? n.presentPct - n.previousPct : 0,
    url: row.url,
  };
}

function detailRow(d: InsightStockDetail | undefined): InsightStockDetailRow | null {
  if (!d) return null;
  return {
    code: d.stockCode,
    name: d.companyName,
    sector: d.sector,
    disclosedPct: d.disclosedPct,
    byKind: d.byKind.map((k) => ({ kind: k.kind, pct: k.pct, holders: k.holders })),
    holders: d.holders,
    latestNoticeDate: d.latestNoticeDate,
    funds: d.funds.map((f) => ({
      institution: f.institutionName,
      slug: f.institutionSlug,
      kind: f.kind,
      fund: f.fundCode && !f.fundName.includes(f.fundCode) ? `${f.fundCode}, ${f.fundName}` : f.fundName,
      sourceKind: f.sourceKind,
      asAt: f.asAt,
      startAsAt: f.startAsAt,
      units: f.hasUnits ? f.units : null,
      value: f.hasValue ? f.valueAud : null,
      startUnits: f.hasStartUnits ? f.startUnits : null,
    })),
    notices: d.notices.map(moveRow),
  };
}

function mapInsights(query: InsightsQuery, part: InsightsPart, r: GetOwnershipInsightsResponse): InsightsPage {
  const page = emptyInsightsPage(query, part);
  const w = r.window;
  page.ok = true;
  if (w) {
    page.window = {
      from: w.from,
      to: w.to,
      timelineFrom: w.timelineFrom,
      timelineTo: w.timelineTo,
      snapshotDates: [...w.snapshotDates],
      noticesFrom: w.noticesFrom,
      noticesTo: w.noticesTo,
      noticesAsOf: w.noticesAsOf,
      bucket: w.bucket === "week" || w.bucket === "month" ? w.bucket : "",
      startFilesFrom: w.startFilesFrom,
      startFilesTo: w.startFilesTo,
      endFilesFrom: w.endFilesFrom,
      endFilesTo: w.endFilesTo,
      fundsCompared: w.fundsCompared,
      fundsAtEnd: w.fundsAtEnd,
      noticesInWindow: w.noticesInWindow,
    };
  }
  if (part === "stock") {
    page.stockDetail = detailRow(r.stockDetail);
    return page;
  }
  page.stocks = r.stocks.map((s) => ({
    code: s.stockCode,
    name: s.companyName,
    sector: s.sector,
    fundValue: s.hasFundValue ? s.fundValueAud : null,
    funds: s.funds,
    fundChangePct: s.hasFundChange ? s.fundChangePct : null,
    fundFlow: s.hasFundFlow ? s.fundFlowAud : null,
    indexPct: s.hasIndexPct ? s.indexPct : null,
    disclosedPct: s.disclosedPct,
    interests: s.interests,
    disclosedValue: s.hasDisclosedValue ? s.disclosedValueAud : null,
    noticeNetPp: s.noticeNetPp,
    notices: s.notices,
  }));
  page.stocksTotal = r.stocksTotal;
  page.moves = r.moves.map(moveRow);
  page.sectorInstitutions = r.sectorInstitutions.map((i) => ({
    slug: i.institutionSlug,
    name: i.institutionName,
    kind: i.kind,
    value: i.hasValue ? i.valueAud : null,
    flow: i.hasFlow ? i.flowAud : null,
  }));
  if (part === "sector") return page;

  page.sectors = r.sectors.map((s) => ({
    sector: s.sector,
    label: sectorLabel(s.sector),
    stocks: s.stocks,
    fundValue: s.hasFundValue ? s.fundValueAud : null,
    fundFlow: s.hasFundFlow ? s.fundFlowAud : null,
    fundChangePct: s.hasFundChange ? s.fundChangePct : null,
    disclosedValue: s.hasDisclosedValue ? s.disclosedValueAud : null,
    superValue: s.hasSuperValue ? s.superValueAud : null,
    noticeNetPp: s.noticeNetPp,
    notices: s.notices,
    rises: s.rises,
    falls: s.falls,
    became: s.became,
    ceased: s.ceased,
    interests: s.interests,
    investorInterests: s.investorInterests,
  }));
  page.remainders = r.remainders.map((x) => ({
    sector: x.sector,
    stocks: x.stocks,
    fundValue: x.fundValueAud,
    disclosedValue: x.disclosedValueAud,
  }));
  page.flowFunds = flowRow(r.flowFunds);
  page.flowDisclosed = flowRow(r.flowDisclosed);
  page.heatmap = {
    buckets: (r.heatmap?.buckets ?? []).map((b) => ({ start: b.start, end: b.end })),
    rows: (r.heatmap?.rows ?? []).map((row) => ({
      sector: row.sector,
      label: sectorLabel(row.sector),
      cells: row.cells.map((c) => ({
        fundFlow: c.hasFundFlow ? c.fundFlowAud : null,
        fundsCompared: c.fundsCompared,
        noticeNetPp: c.noticeNetPp,
        notices: c.notices,
        rises: c.rises,
        falls: c.falls,
        became: c.became,
        ceased: c.ceased,
      })),
    })),
  };
  page.timeline = r.timeline.map((t) => ({ month: t.month, notices: t.notices, files: t.files }));
  page.stockDetail = detailRow(r.stockDetail);
  return page;
}
