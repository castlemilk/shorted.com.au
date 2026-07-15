import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";
import { cache } from "react";
import { unstable_cache } from "next/cache";
import { SHORTS_API_URL, serverFetchOutsideNextCache } from "../config";
import { withRetryAndNotFound, type RetryOptions } from "../withRetry";
import { withSpan } from "~/@/lib/tracing";

// Shared transport instance — reused across all functions to avoid redundant HTTP/2 connection setup
function getTransport() {
  return createConnectTransport({
    fetch: serverFetchOutsideNextCache,
    baseUrl: SHORTS_API_URL,
  });
}

// Lighter retry config for report data that's typically pre-cached
const LIGHT_RETRY: Partial<RetryOptions> = {
  maxRetries: 2,
  initialDelayMs: 200,
  maxDelayMs: 2000,
};

export interface ReportStock {
  code: string;
  name: string;
  shortPercent: number;
  industry: string;
}

export interface WeeklyReportData {
  weekSlug: string; // e.g., "2026-W06"
  startDate: string;
  endDate: string;
  dates: string[];
  topStocks: ReportStock[];
  totalStocksShorted: number;
}

export interface MonthlyReportData {
  monthSlug: string; // e.g., "2026-01"
  month: string;
  year: string;
  dates: string[];
  topStocks: ReportStock[];
  totalStocksShorted: number;
}

// Get the ISO week number and year for a date
function getISOWeek(date: Date): { year: number; week: number } {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { year: d.getUTCFullYear(), week: weekNo };
}

// Get the date range for an ISO week
function getWeekDateRange(year: number, week: number): { start: Date; end: Date } {
  const simple = new Date(Date.UTC(year, 0, 1 + (week - 1) * 7));
  const dow = simple.getUTCDay();
  const start = new Date(simple);
  if (dow <= 4) {
    start.setUTCDate(simple.getUTCDate() - simple.getUTCDay() + 1);
  } else {
    start.setUTCDate(simple.getUTCDate() + 8 - simple.getUTCDay());
  }
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 4); // Friday
  return { start, end };
}

// Parse a week slug like "2026-W06" into year and week
function parseWeekSlug(slug: string): { year: number; week: number } | null {
  const match = slug.match(/^(\d{4})-W(\d{2})$/);
  if (!match?.[1] || !match[2]) return null;
  return { year: parseInt(match[1]), week: parseInt(match[2]) };
}

// Inner fetch for weekly report data
async function fetchWeeklyReport(weekSlug: string): Promise<WeeklyReportData> {
  const parsed = parseWeekSlug(weekSlug);
  if (!parsed) throw new Error(`Invalid week slug: ${weekSlug}`);

  const { start, end } = getWeekDateRange(parsed.year, parsed.week);
  const startStr = start.toISOString().slice(0, 10);
  const endStr = end.toISOString().slice(0, 10);

  return withSpan(
    "report.fetch.weekly",
    { weekSlug, startDate: startStr, endDate: endStr },
    async () => {
      const transport = getTransport();
      const client = createClient(ShortedStocksService, transport);

      // Clamp the market-data query to the newest available trading date
      // WITHIN the week. Fresh reports publish Friday but the Friday's ASIC
      // data lags ~4-6 days (T+4) — querying endStr returned zero stocks,
      // which soft-404'd every report right when it was newest (July 2026).
      const availableDates = await client.getAvailableDates({ limit: 5, before: "" });
      const weekDates = availableDates.dates.filter((d) => d >= startStr && d <= endStr);
      const queryDate = weekDates[0] ?? endStr;
      const marketData = await client.getMarketByDate({
        date: queryDate,
        limit: 50,
        offset: 0,
      });

      return {
        weekSlug,
        startDate: startStr,
        endDate: endStr,
        dates: weekDates,
        topStocks: marketData.stocks.map((s) => ({
          code: s.productCode ?? "",
          name: s.name ?? "",
          shortPercent: s.percentageShorted,
          industry: s.industry ?? "",
        })),
        totalStocksShorted: marketData.totalCount,
      };
    },
  );
}

// Get weekly report data — persistently cached across requests (24h)
// unstable_cache wraps the raw fetch (throws on failure → cache miss, no stale data cached)
// withRetryAndNotFound wraps the outer call (returns undefined on error for graceful SSR)
export const getWeeklyReportData = cache(
  withRetryAndNotFound(async (weekSlug: string) => {
    return await unstable_cache(
      () => fetchWeeklyReport(weekSlug),
      [`weekly-report-${weekSlug}`],
      { tags: [`report-${weekSlug}`], revalidate: 86400 },
    )();
  }, LIGHT_RETRY),
);

// Inner fetch for monthly report data
async function fetchMonthlyReport(monthSlug: string): Promise<MonthlyReportData> {
  const match = monthSlug.match(/^(\d{4})-(\d{2})$/);
  if (!match?.[1] || !match[2]) throw new Error(`Invalid month slug: ${monthSlug}`);

  const year = match[1];
  const month = match[2];
  const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
  const endDate = `${year}-${month}-${String(lastDay).padStart(2, "0")}`;

  const transport = getTransport();
  const client = createClient(ShortedStocksService, transport);

  const monthNum = parseInt(month);
  const yearNum = parseInt(year);
  const nextMonthDate = `${monthNum === 12 ? yearNum + 1 : yearNum}-${String(monthNum === 12 ? 1 : monthNum + 1).padStart(2, "0")}-01`;

  const [availableDates, marketData] = await Promise.all([
    client.getAvailableDates({ limit: 31, before: nextMonthDate }),
    client.getMarketByDate({ date: endDate, limit: 50, offset: 0 }),
  ]);

  const monthDates = availableDates.dates.filter((d) => d.startsWith(`${year}-${month}`));
  const monthName = new Date(`${year}-${month}-01T00:00:00`).toLocaleDateString("en-AU", { month: "long" });

  return {
    monthSlug,
    month: monthName,
    year,
    dates: monthDates,
    topStocks: marketData.stocks.map((s) => ({
      code: s.productCode ?? "",
      name: s.name ?? "",
      shortPercent: s.percentageShorted,
      industry: s.industry ?? "",
    })),
    totalStocksShorted: marketData.totalCount,
  };
}

// Get monthly report data — persistently cached across requests (24h)
export const getMonthlyReportData = cache(
  withRetryAndNotFound(async (monthSlug: string) => {
    return await unstable_cache(
      () => fetchMonthlyReport(monthSlug),
      [`monthly-report-${monthSlug}`],
      { tags: [`report-${monthSlug}`], revalidate: 86400 },
    )();
  }, LIGHT_RETRY),
);

// Generate available week slugs (last 52 weeks, excluding the current in-progress week)
// Reports are generated on the Friday of the same week, so last week's report already
// exists — only the current week may still be missing one.
export async function getAvailableWeekSlugs(): Promise<string[]> {
  const slugs: string[] = [];
  const now = new Date();
  const currentWeek = getISOWeek(now);
  const currentSlug = `${currentWeek.year}-W${String(currentWeek.week).padStart(2, "0")}`;

  for (let i = 0; i < 52; i++) {
    const date = new Date(now);
    date.setDate(date.getDate() - i * 7);
    const { year, week } = getISOWeek(date);
    const slug = `${year}-W${String(week).padStart(2, "0")}`;
    // Skip the current week (report generated Friday, may not exist yet) and duplicates
    if (slug !== currentSlug && !slugs.includes(slug)) {
      slugs.push(slug);
    }
  }
  return slugs;
}

// A citation referencing a data source in the weekly report narrative
export interface ReportCitation {
  id: string; // "ref-1"
  source: string; // "BHP H1 FY2025 Results"
  date: string;
  url: string;
  type: string; // "financial_report", "announcement", "asic_data", "price_data"
}

// A stock row in the enhanced report top-shorted list.
// New snapshot fields (daysToCover, isNewEntrant, industry, history, logoUrl)
// are zero/empty for reports generated before the snapshot was extended —
// consumers must degrade gracefully.
export interface EnhancedReportStock {
  rank: number;
  code: string;
  name: string;
  shortPct: number;
  wowChange: number;
  /** Reported short shares / 20-day average volume (0 = unknown) */
  daysToCover: number;
  /** New to the top list this period */
  isNewEntrant: boolean;
  industry: string;
  /** Weekly short % history, oldest first (~13 points; empty on old reports) */
  history: number[];
  /** Company logo icon URL (hydrated at read time; "" when unknown) */
  logoUrl: string;
}

// A riser/faller in the enhanced report
export interface EnhancedReportMover {
  code: string;
  name: string;
  currentPct: number;
  previousPct: number;
  change: number;
  /** Reported short shares / 20-day average volume (0 = unknown) */
  daysToCover: number;
  /** How unusual this move is vs the stock's own weekly-change history (0 = unknown) */
  zScore: number;
  /** Consecutive weeks moving in the same direction (0 = unknown) */
  streakWeeks: number;
  industry: string;
  /** Weekly short % history, oldest first (~13 points; empty on old reports) */
  history: number[];
  /** Company logo icon URL (hydrated at read time; "" when unknown) */
  logoUrl: string;
  /** Composite significance score used for ranking movers */
  significance: number;
}

// Aggregate short interest by industry for the report period
export interface ReportIndustryStat {
  industry: string;
  avgShortPct: number;
  wowChange: number;
  stockCount: number;
  topStockCode: string;
  topStockPct: number;
}

// Enhanced weekly report data including LLM narrative (from weekly_reports table)
export interface EnhancedWeeklyReportNarrative {
  headline: string;
  summary: string;
  narrative: {
    openingHook: string;
    topAnalysis: string;
    moversAnalysis: string;
    industryAnalysis: string;
    outlook: string;
  };
  topShorted: EnhancedReportStock[];
  risers: EnhancedReportMover[];
  fallers: EnhancedReportMover[];
  faqs: Array<{
    question: string;
    answer: string;
  }>;
  citations: ReportCitation[];
  industryBreakdown: ReportIndustryStat[];
  marketStats?: {
    totalStocksShorted: number;
    avgShortPct: number;
    maxShortPct: number;
    maxShortCode: string;
    wowAvgChange: number;
    /** 0 when absent (old reports) */
    medianShortPct: number;
    /** Count of stocks with short interest >= 10% (0 when absent) */
    stocksAbove10Pct: number;
    /** Count of stocks with short interest >= 5% (0 when absent) */
    stocksAbove5Pct: number;
    /** Market-wide count of stocks whose short % rose (0 when absent) */
    riserCount: number;
    /** Market-wide count of stocks whose short % fell (0 when absent) */
    fallerCount: number;
  };
  qualityScore: number;
}

// gRPC/Connect error code for NotFound - hardcoded to avoid SSR-breaking import
const CODE_NOT_FOUND = 5;

function isConnectError(error: unknown): error is { code: number; message: string } {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof (error as Record<string, unknown>).code === "number" &&
    "message" in error
  );
}

// Inner fetch function for enhanced report data — returns null for "not found" (report doesn't
// exist) so unstable_cache caches null correctly. Only throws on transient errors.
async function fetchEnhancedReport(weekSlug: string): Promise<EnhancedWeeklyReportNarrative | null> {
  let resp;
  try {
    resp = await withSpan(
      "report.fetch.enhanced",
      { weekSlug },
      async () => {
        const transport = getTransport();
        const client = createClient(ShortedStocksService, transport);
        return client.getWeeklyReport({ weekSlug });
      },
    );
  } catch (err) {
    // NotFound means report doesn't exist for this week — safe to cache as null
    if (isConnectError(err) && err.code === CODE_NOT_FOUND) {
      return null;
    }
    // Re-throw transient errors so unstable_cache doesn't cache failures
    throw err;
  }

  // Empty response means report doesn't exist for this week — safe to cache as null
  if (!resp.headline && !resp.narrative?.openingHook) {
    return null;
  }

  return {
    headline: resp.headline,
    summary: resp.summary,
    narrative: {
      openingHook: resp.narrative?.openingHook ?? "",
      topAnalysis: resp.narrative?.topAnalysis ?? "",
      moversAnalysis: resp.narrative?.moversAnalysis ?? "",
      industryAnalysis: resp.narrative?.industryAnalysis ?? "",
      outlook: resp.narrative?.outlook ?? "",
    },
    topShorted: resp.topShorted.map((s) => ({
      rank: s.rank,
      code: s.code,
      name: s.name,
      shortPct: s.shortPct,
      wowChange: s.wowChange,
      daysToCover: s.daysToCover ?? 0,
      isNewEntrant: s.isNewEntrant ?? false,
      industry: s.industry ?? "",
      history: s.history ?? [],
      logoUrl: s.logoUrl ?? "",
    })),
    risers: resp.risers.map(mapMover),
    fallers: resp.fallers.map(mapMover),
    faqs: resp.faqs.map((f) => ({
      question: f.question,
      answer: f.answer,
    })),
    citations: (resp.citations ?? []).map((c) => ({
      id: c.id,
      source: c.source,
      date: c.date,
      url: c.url,
      type: c.type,
    })),
    industryBreakdown: (resp.industryBreakdown ?? []).map((i) => ({
      industry: i.industry,
      avgShortPct: i.avgShortPct,
      wowChange: i.wowChange,
      stockCount: i.stockCount,
      topStockCode: i.topStockCode,
      topStockPct: i.topStockPct,
    })),
    marketStats: resp.marketStats
      ? {
          totalStocksShorted: resp.marketStats.totalStocksShorted,
          avgShortPct: resp.marketStats.avgShortPct,
          maxShortPct: resp.marketStats.maxShortPct,
          maxShortCode: resp.marketStats.maxShortCode,
          wowAvgChange: resp.marketStats.wowAvgChange,
          medianShortPct: resp.marketStats.medianShortPct ?? 0,
          stocksAbove10Pct: resp.marketStats.stocksAbove10pct ?? 0,
          stocksAbove5Pct: resp.marketStats.stocksAbove5pct ?? 0,
          riserCount: resp.marketStats.riserCount ?? 0,
          fallerCount: resp.marketStats.fallerCount ?? 0,
        }
      : undefined,
    qualityScore: resp.qualityScore,
  };
}

// Maps a generated proto mover to the plain narrative shape, defaulting the
// snapshot fields that old reports lack.
function mapMover(m: {
  code: string;
  name: string;
  currentPct: number;
  previousPct: number;
  change: number;
  daysToCover?: number;
  zScore?: number;
  streakWeeks?: number;
  industry?: string;
  history?: number[];
  logoUrl?: string;
  significance?: number;
}): EnhancedReportMover {
  return {
    code: m.code,
    name: m.name,
    currentPct: m.currentPct,
    previousPct: m.previousPct,
    change: m.change,
    daysToCover: m.daysToCover ?? 0,
    zScore: m.zScore ?? 0,
    streakWeeks: m.streakWeeks ?? 0,
    industry: m.industry ?? "",
    history: m.history ?? [],
    logoUrl: m.logoUrl ?? "",
    significance: m.significance ?? 0,
  };
}

// Fetch enhanced weekly report narrative with on-demand revalidation support
// unstable_cache wraps the raw fetch (throws on transient error → no stale null cached)
// Outer try/catch returns null for SSR graceful degradation (not cached)
export async function getEnhancedWeeklyReportData(weekSlug: string): Promise<EnhancedWeeklyReportNarrative | null> {
  try {
    return await unstable_cache(
      () => fetchEnhancedReport(weekSlug),
      [`enhanced-report-${weekSlug}`],
      {
        tags: [`report-${weekSlug}`],
        revalidate: 86400, // 24h fallback
      },
    )();
  } catch (err) {
    // Transient error — don't cache, just return null for this request
    console.error(`[getEnhancedWeeklyReportData] Failed for slug=${weekSlug}:`, err);
    return null;
  }
}

// Generate available month slugs (last 24 months, excluding the current incomplete month)
export async function getAvailableMonthSlugs(): Promise<string[]> {
  const slugs: string[] = [];
  const now = new Date();
  // Start from previous month (current month is incomplete)
  for (let i = 1; i <= 24; i++) {
    const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
    slugs.push(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`);
  }
  return slugs;
}

// Financial highlights for a stock
export interface StockFinancialHighlight {
  reportTitle: string;
  reportType: string;
  reportDate: string;
  metrics: Array<{
    metricType: string; // e.g., "revenue", "net_profit", "eps"
    sourceText: string;
    attributes: Record<string, string>; // e.g., {value_millions: "5142", period: "H1 FY2025"}
  }>;
  digest: string;       // Flash-distilled 2-3 sentence plain-English summary
  confidence: number;   // 0.0–1.0 digest confidence score
}

// Inner fetch for financial highlights
async function fetchStockFinancialHighlights(
  stockCodes: string[],
): Promise<Record<string, StockFinancialHighlight[]>> {
  try {
    const transport = getTransport();
    const client = createClient(ShortedStocksService, transport);

    const resp = await client.getStockFinancialHighlights({
      stockCodes,
      maxReportsPerStock: 2,
    });

    const result: Record<string, StockFinancialHighlight[]> = {};
    for (const [code, data] of Object.entries(resp.highlights)) {
      result[code] = data.reports.map((r) => ({
        reportTitle: r.reportTitle,
        reportType: r.reportType,
        reportDate: r.reportDate,
        metrics: r.metrics.map((m) => ({
          metricType: m.metricType,
          sourceText: m.sourceText,
          attributes: Object.fromEntries(
            Object.entries(m.attributes),
          ),
        })),
        digest: r.digest,
        confidence: r.confidence,
      }));
    }
    return result;
  } catch {
    return {};
  }
}

// Fetch financial highlights — persistently cached across requests (24h)
// Cache key uses sorted codes to ensure stable keys regardless of input order
export const getStockFinancialHighlights = cache(
  (stockCodes: string[]) => {
    const sortedKey = [...stockCodes].sort().join(",");
    return unstable_cache(
      () => fetchStockFinancialHighlights(stockCodes),
      [`financial-highlights-${sortedKey}`],
      { revalidate: 86400 },
    )();
  },
);

// Summary of a published report for archive/index pages
export interface ReportListEntry {
  slug: string; // "2026-W06", "2026-01", or "2025"
  reportType: string; // "weekly", "monthly", "yearly"
  headline: string;
  summary: string;
  reportDate: string; // YYYY-MM-DD of latest trading day in the period
  maxShortPct: number;
  maxShortCode: string;
  totalStocksShorted: number;
  qualityScore: number;
  /** Top shorted stock codes (up to 5) */
  topCodes: string[];
  /** Matching logo icon URLs (parallel to topCodes, "" when unknown) */
  topLogoUrls: string[];
}

// Inner fetch for the published-reports archive
async function fetchReportsList(
  reportType: string,
  limit: number,
): Promise<ReportListEntry[]> {
  return withSpan("report.fetch.list", { reportType, limit }, async () => {
    const transport = getTransport();
    const client = createClient(ShortedStocksService, transport);
    const resp = await client.listReports({ reportType, limit });
    // Defense against partial rows: the generator can leave a published_at
    // row whose narrative never landed (July 2026: a 2026-W28 row surfaced
    // as the "latest" featured card while GetWeeklyReport had nothing to
    // render — a sitemapped soft-404). A real published report always has a
    // headline, so gate on it.
    return (resp.reports ?? [])
      .filter((r) => (r.headline ?? "").trim().length > 0)
      .map((r) => ({
      slug: r.slug,
      reportType: r.reportType,
      headline: r.headline,
      summary: r.summary,
      reportDate: r.reportDate,
      maxShortPct: r.maxShortPct,
      maxShortCode: r.maxShortCode,
      totalStocksShorted: r.totalStocksShorted,
      qualityScore: r.qualityScore,
      topCodes: r.topCodes ?? [],
      topLogoUrls: r.topLogoUrls ?? [],
    }));
  });
}

// Fetch the published-reports archive — persistently cached across requests (1h).
// Gracefully degrades to an empty array on any error so the /reports index can
// fall back to its slug-generated card grid rather than 500ing.
export async function getReportsList(
  reportType = "",
  limit = 24,
): Promise<ReportListEntry[]> {
  try {
    return await unstable_cache(
      () => fetchReportsList(reportType, limit),
      [`reports-list-${reportType || "all"}-${limit}`],
      { tags: ["reports-index"], revalidate: 3600 },
    )();
  } catch (err) {
    console.error(`[getReportsList] Failed for type=${reportType}:`, err);
    return [];
  }
}

// Generate available year slugs (last 5 completed years, excluding the current year)
export async function getAvailableYearSlugs(): Promise<string[]> {
  const slugs: string[] = [];
  const currentYear = new Date().getFullYear();
  // Start from previous year (current year is incomplete)
  for (let i = 1; i <= 5; i++) {
    slugs.push(String(currentYear - i));
  }
  return slugs;
}
