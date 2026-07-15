import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { unstable_cache } from "next/cache";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";
import {
  SHORTS_API_URL,
  serverFetchWithUserAgent,
  skipForBuild,
} from "./config";
import { getScan, type ScanRange } from "~/@/lib/scans/registry";

// Results for one /scans/[slug] page — a filtered slice of the screener MV.

export interface ScanRow {
  code: string;
  name: string;
  industry: string;
  shortPct: number;
  shortPctChange4w: number;
  latestPrice: number;
  priceChange1m: number;
  daysToCover: number;
}

export interface ScanResults {
  /** Latest ASIC data date (YYYY-MM-DD). */
  asOfDate: string;
  rows: ScanRow[];
  totalCount: number;
}

// Registry ranges → proto RangeFilter shape (hasMin/hasMax gate the bounds
// server-side — see appendRangeFilter in postgres_screener.go).
function toRangeFilter(range: ScanRange | undefined) {
  if (!range) return undefined;
  return {
    min: range.min ?? 0,
    hasMin: range.min !== undefined,
    max: range.max ?? 0,
    hasMax: range.max !== undefined,
  };
}

const SCAN_ROW_LIMIT = 100;

async function fetchScanResults(slug: string): Promise<ScanResults> {
  const scan = getScan(slug);
  if (!scan) return { asOfDate: "", rows: [], totalCount: 0 };

  const transport = createConnectTransport({
    fetch: serverFetchWithUserAgent,
    baseUrl: SHORTS_API_URL,
  });
  const client = createClient(ShortedStocksService, transport);

  const [screen, dates] = await Promise.all([
    client.screenStocks({
      filters: {
        shortPct: toRangeFilter(scan.filters.shortPct),
        shortPctChange: toRangeFilter(scan.filters.shortPctChange),
        priceChange1m: toRangeFilter(scan.filters.priceChange1m),
        daysToCover: toRangeFilter(scan.filters.daysToCover),
        marketCap: toRangeFilter(scan.filters.marketCap),
        industries: [],
        hasDirectorBuys: false,
      },
      sortField: scan.sortField,
      sortDirection: scan.sortDirection,
      limit: SCAN_ROW_LIMIT, // API validates limit <= 200
      offset: 0,
    }),
    client.getAvailableDates({ limit: 1, before: "" }),
  ]);

  return {
    asOfDate: dates.dates[0] ?? "",
    rows: (screen.stocks ?? []).map((s) => ({
      code: s.stockCode,
      name: s.companyName,
      industry: s.industry,
      shortPct: s.shortPct,
      shortPctChange4w: s.shortPctChange4w,
      latestPrice: s.latestPrice,
      priceChange1m: s.priceChange1m,
      daysToCover: s.daysToCover,
    })),
    totalCount: screen.totalCount ?? 0,
  };
}

// ISR-safe: connect call inside unstable_cache (same proven pattern as
// getReportsList / getShortStatistics). Degrades to null so pages render
// their static copy if the API is down. Build prerenders skip the fetch.
export async function getScanResults(slug: string): Promise<ScanResults | null> {
  if (skipForBuild()) return null;
  try {
    const results = await unstable_cache(
      () => fetchScanResults(slug),
      [`scan-results-${slug}-v1`],
      { tags: ["scan-results", `scan-${slug}`], revalidate: 3600 },
    )();
    return results.asOfDate ? results : null;
  } catch (err) {
    console.error(`[getScanResults] failed for ${slug}:`, err);
    return null;
  }
}
