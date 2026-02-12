import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";
import { cache } from "react";
import { unstable_cache } from "next/cache";
import { SHORTS_API_URL } from "../config";
import { withRetryAndNotFound, type RetryOptions } from "../withRetry";

const PRODUCTION_API_URL = "https://api.shorted.com.au";

function getApiUrl() {
  return process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT ?? SHORTS_API_URL ?? PRODUCTION_API_URL;
}

// Shared transport instance — reused across all functions to avoid redundant HTTP/2 connection setup
function getTransport() {
  return createConnectTransport({ baseUrl: getApiUrl() });
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

// Get weekly report data by fetching the last day of the week
export const getWeeklyReportData = cache(
  withRetryAndNotFound(async (weekSlug: string): Promise<WeeklyReportData> => {
    const parsed = parseWeekSlug(weekSlug);
    if (!parsed) throw new Error(`Invalid week slug: ${weekSlug}`);

    const { start, end } = getWeekDateRange(parsed.year, parsed.week);
    const startStr = start.toISOString().slice(0, 10);
    const endStr = end.toISOString().slice(0, 10);

    const transport = getTransport();
    const client = createClient(ShortedStocksService, transport);

    // Fetch dates and market data in parallel to eliminate serial round-trip
    const [availableDates, marketData] = await Promise.all([
      client.getAvailableDates({ limit: 5, before: "" }),
      client.getMarketByDate({ date: endStr, limit: 50, offset: 0 }),
    ]);

    const weekDates = availableDates.dates.filter((d) => d >= startStr && d <= endStr);

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
  }, LIGHT_RETRY),
);

// Get monthly report data
export const getMonthlyReportData = cache(
  withRetryAndNotFound(async (monthSlug: string): Promise<MonthlyReportData> => {
    const match = monthSlug.match(/^(\d{4})-(\d{2})$/);
    if (!match?.[1] || !match[2]) throw new Error(`Invalid month slug: ${monthSlug}`);

    const year = match[1];
    const month = match[2];
    const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
    const endDate = `${year}-${month}-${String(lastDay).padStart(2, "0")}`;

    const transport = getTransport();
    const client = createClient(ShortedStocksService, transport);

    // Get available dates for this month
    const monthNum = parseInt(month);
    const yearNum = parseInt(year);
    const nextMonthDate = `${monthNum === 12 ? yearNum + 1 : yearNum}-${String(monthNum === 12 ? 1 : monthNum + 1).padStart(2, "0")}-01`;

    // Fetch dates and market data in parallel to eliminate serial round-trip
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
  }, LIGHT_RETRY),
);

// Generate available week slugs (last 52 weeks, excluding the current and most recent week)
// Reports are generated after the week ends with a processing delay, so we skip 2 weeks
export async function getAvailableWeekSlugs(): Promise<string[]> {
  const slugs: string[] = [];
  const now = new Date();
  const currentWeek = getISOWeek(now);
  const currentSlug = `${currentWeek.year}-W${String(currentWeek.week).padStart(2, "0")}`;

  // Also compute last week's slug (may not have report generated yet)
  const lastWeekDate = new Date(now);
  lastWeekDate.setDate(lastWeekDate.getDate() - 7);
  const lastWeek = getISOWeek(lastWeekDate);
  const lastWeekSlug = `${lastWeek.year}-W${String(lastWeek.week).padStart(2, "0")}`;

  for (let i = 0; i < 52; i++) {
    const date = new Date(now);
    date.setDate(date.getDate() - i * 7);
    const { year, week } = getISOWeek(date);
    const slug = `${year}-W${String(week).padStart(2, "0")}`;
    // Skip current week and last week (report likely not generated yet), and duplicates
    if (slug !== currentSlug && slug !== lastWeekSlug && !slugs.includes(slug)) {
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
  topShorted: Array<{
    rank: number;
    code: string;
    name: string;
    shortPct: number;
    wowChange: number;
  }>;
  risers: Array<{
    code: string;
    name: string;
    currentPct: number;
    previousPct: number;
    change: number;
  }>;
  fallers: Array<{
    code: string;
    name: string;
    currentPct: number;
    previousPct: number;
    change: number;
  }>;
  faqs: Array<{
    question: string;
    answer: string;
  }>;
  citations: ReportCitation[];
  marketStats?: {
    totalStocksShorted: number;
    avgShortPct: number;
    maxShortPct: number;
    maxShortCode: string;
    wowAvgChange: number;
  };
  qualityScore: number;
}

// Inner fetch function for enhanced report data (used by both cache layers)
async function fetchEnhancedReport(weekSlug: string): Promise<EnhancedWeeklyReportNarrative | null> {
    try {
      const transport = getTransport();
      const client = createClient(ShortedStocksService, transport);

      const resp = await client.getWeeklyReport({ weekSlug });

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
        })),
        risers: resp.risers.map((m) => ({
          code: m.code,
          name: m.name,
          currentPct: m.currentPct,
          previousPct: m.previousPct,
          change: m.change,
        })),
        fallers: resp.fallers.map((m) => ({
          code: m.code,
          name: m.name,
          currentPct: m.currentPct,
          previousPct: m.previousPct,
          change: m.change,
        })),
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
        marketStats: resp.marketStats
          ? {
              totalStocksShorted: resp.marketStats.totalStocksShorted,
              avgShortPct: resp.marketStats.avgShortPct,
              maxShortPct: resp.marketStats.maxShortPct,
              maxShortCode: resp.marketStats.maxShortCode,
              wowAvgChange: resp.marketStats.wowAvgChange,
            }
          : undefined,
        qualityScore: resp.qualityScore,
      };
    } catch (err) {
      // Narrative not available for this week (expected for older weeks)
      console.error(`[getEnhancedWeeklyReportData] Failed for slug=${weekSlug}:`, err);
      return null;
    }
}

// Fetch enhanced weekly report narrative with on-demand revalidation support
// Uses unstable_cache with tags so the report generator can trigger revalidation via POST /api/revalidate?tag=report-SLUG
export const getEnhancedWeeklyReportData = cache(
  (weekSlug: string) => {
    const cachedFetch = unstable_cache(
      () => fetchEnhancedReport(weekSlug),
      [`enhanced-report-${weekSlug}`],
      {
        tags: [`report-${weekSlug}`],
        revalidate: 86400, // 24h fallback
      },
    );
    return cachedFetch();
  },
);

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
}

// Fetch financial highlights for given stock codes
export const getStockFinancialHighlights = cache(
  async (
    stockCodes: string[],
  ): Promise<Record<string, StockFinancialHighlight[]>> => {
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
        }));
      }
      return result;
    } catch {
      return {};
    }
  },
);

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
