import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { unstable_cache } from "next/cache";
import { MarketService } from "~/gen/shorts/v1alpha1/market_pb";
import { ScreenerService } from "~/gen/shorts/v1alpha1/screener_pb";
import {
  SHORTS_API_URL,
  serverFetchOutsideNextCache,
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
    fetch: serverFetchOutsideNextCache,
    baseUrl: SHORTS_API_URL,
  });
  const marketClient = createClient(MarketService, transport);
  const screenerClient = createClient(ScreenerService, transport);

  const [screen, dates] = await Promise.all([
    screenerClient.screenStocks({
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
    marketClient.getAvailableDates({ limit: 1, before: "" }),
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
    return await unstable_cache(
      async () => {
        const results = await fetchScanResults(slug);
        // Never CACHE a data-less result — throwing makes it a cache miss
        // so the next request retries instead of pinning an empty shell.
        if (!results.asOfDate) {
          throw new Error("scan returned no data date");
        }
        return results;
      },
      [`scan-results-${slug}-v1`],
      { tags: ["scan-results", `scan-${slug}`], revalidate: 3600 },
    )();
  } catch (err) {
    console.error(`[getScanResults] failed for ${slug}:`, err);
    return null;
  }
}
