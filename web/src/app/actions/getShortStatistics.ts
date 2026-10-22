import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { unstable_cache } from "next/cache";
import {
  ScreenerSortField,
  SortDirection,
  type ScreenerStock,
} from "~/gen/shorts/v1alpha1/screener_pb";
import { MarketService } from "~/gen/shorts/v1alpha1/market_pb";
import { ScreenerService } from "~/gen/shorts/v1alpha1/screener_pb";
import {
  SHORTS_API_URL,
  bailOnEmptyRender,
  serverFetchOutsideNextCache,
  skipForBuild,
} from "./config";
import { getAvailableDates } from "./market/getMarketByDate";
import { industryLabel } from "~/@/lib/industry-placeholder";

// Aggregate market-wide short-selling statistics for /statistics — the
// citable numbers journalists currently pull from competitors' JS-only
// charts, published here as crawlable server-rendered text.
//
// Dollar-value estimate: short % and market cap both derive from issued
// shares × price, so $ shorted = short_pct/100 × market_cap. Rows without a
// market cap are excluded from dollar sums (counted in excludedCount).
//
// The universe is the latest ASIC report, not the screener. mv_screener_data
// keeps each code's newest positive row with no recency bound, so a code ASIC
// stopped reporting in 2012 still has a row, and its "4-week change" is
// measured against 28 days before ITS last report. On 2026-10-21 only 712 of
// the 3,299 screener rows were in the latest report (2026-10-15): the page
// claimed 3,299 companies, an average short interest of 0.43% (1.55% over the
// report), and led "Shorts building" with CSJ (last reported 2012-08-01), EHE,
// CZZ and TPD, and "Shorts covering" with REY (2011-12-29). Every aggregate
// below is computed over rows whose code is in that report.

export interface ShortedStockDollar {
  code: string;
  name: string;
  industry: string;
  shortPct: number;
  dollarsShorted: number;
}

export interface IndustryShortStat {
  industry: string;
  dollarsShorted: number;
  stockCount: number;
  avgShortPct: number;
}

export interface ShortMover {
  code: string;
  name: string;
  shortPct: number;
  change4w: number;
}

export interface ShortStatistics {
  /** Latest ASIC data date (YYYY-MM-DD). */
  asOfDate: string;
  totalDollarsShorted: number;
  /** Stocks with a reported short position in the screener universe. */
  stockCount: number;
  /** Stocks excluded from dollar sums for missing market cap. */
  excludedCount: number;
  avgShortPct: number;
  stocksAbove10Pct: number;
  stocksAbove5Pct: number;
  topByDollars: ShortedStockDollar[];
  bankBasket: ShortedStockDollar[];
  bankBasketTotal: number;
  industries: IndustryShortStat[];
  risers: ShortMover[];
  fallers: ShortMover[];
}

const BANK_CODES = ["ANZ", "CBA", "NAB", "WBC"];

function createClients() {
  const transport = createConnectTransport({
    fetch: serverFetchOutsideNextCache,
    baseUrl: SHORTS_API_URL,
  });
  return {
    marketClient: createClient(MarketService, transport),
    screenerClient: createClient(ScreenerService, transport),
  };
}

// The screener universe (equities only — the MV excludes ETFs/bonds per
// migration 000043), in pages of 200: the API validates limit <= 200.
//
// The backstop used to be 15 pages = exactly 3,000 rows, which the universe
// had already outgrown (totalCount 3,267 on 2026-07-30) — so `stockCount`
// was reporting the CAP, not the count, on the page we ask journalists to
// cite. The backstop now has genuine headroom and only exists to bound a
// runaway loop.
const PAGE = 200;
const MAX_PAGES = 40; // 8,000 rows — ~2.4x the current universe
// The pages after the first go out this many at a time. They used to be
// awaited one by one: 17 sequential calls were the 1.7 s cold render
// measured on 2026-10-21, against ~0.1 s per call from the region.
const PAGE_CONCURRENCY = 4;

async function fetchScreenerUniverse(
  screenerClient: ReturnType<typeof createClients>["screenerClient"],
): Promise<ScreenerStock[]> {
  const page = (offset: number) =>
    screenerClient.screenStocks({
      sortField: ScreenerSortField.SHORT_PCT,
      sortDirection: SortDirection.DESC,
      limit: PAGE,
      offset,
    });

  // The first page reports totalCount, which sizes the rest.
  const firstPage = await page(0);
  const rows = [...(firstPage.stocks ?? [])];
  const totalCount = firstPage.totalCount ?? rows.length;
  const offsets: number[] = [];
  for (
    let offset = PAGE;
    offset < totalCount && offset < PAGE * MAX_PAGES;
    offset += PAGE
  ) {
    offsets.push(offset);
  }
  for (let i = 0; i < offsets.length; i += PAGE_CONCURRENCY) {
    const batch = await Promise.all(
      offsets.slice(i, i + PAGE_CONCURRENCY).map(page),
    );
    for (const p of batch) rows.push(...(p.stocks ?? []));
    // An empty page means the universe ended early: ask for no more.
    if (batch.some((p) => !p.stocks?.length)) break;
  }
  return rows;
}

// GetMarketByDate's limit cap. One page covers a report today (828 codes with
// a short position on 2026-10-15); the loop is headroom, not the common case.
const REPORT_PAGE = 1000;

/**
 * The codes ASIC reported a short position for on `date`. Cached per date:
 * the read is expensive cold (~2.5 s for 828 rows, measured 2026-10-21) and a
 * report never changes once loaded, except by a re-sync, whose `shorts-data`
 * revalidation busts it. Only the codes are kept, not the 0.5 MB response.
 * Throws when the report holds nothing: the statistics are then withheld,
 * never computed over the unbounded screener rows.
 */
function getReportCodes(date: string): Promise<string[]> {
  return unstable_cache(
    async () => {
      const { marketClient } = createClients();
      const codes = new Set<string>();
      for (let offset = 0; ; offset += REPORT_PAGE) {
        const report = await marketClient.getMarketByDate({
          date,
          limit: REPORT_PAGE,
          offset,
        });
        for (const stock of report.stocks ?? []) {
          if (stock.percentageShorted > 0) codes.add(stock.productCode);
        }
        const fetched = offset + (report.stocks?.length ?? 0);
        if ((report.stocks?.length ?? 0) < REPORT_PAGE || fetched >= report.totalCount) break;
      }
      if (codes.size === 0) {
        throw new Error(`ASIC report ${date} holds no short positions`);
      }
      return [...codes].sort();
    },
    ["asic-report-codes-v1", date],
    { tags: ["shorts-data"], revalidate: 86400 },
  )();
}

async function fetchShortStatistics(
  asOfDate: string,
  reportCodes: ReadonlySet<string>,
): Promise<ShortStatistics> {
  const { screenerClient } = createClients();
  const allRows = await fetchScreenerUniverse(screenerClient);

  // Only the latest report's codes: the rest are rows from codes ASIC no
  // longer reports (see the note at the top of this file).
  const stocks = allRows.filter(
    (s) => s.shortPct > 0 && reportCodes.has(s.stockCode),
  );
  const withCap = stocks.filter((s) => s.marketCap > 0);
  const excludedCount = stocks.length - withCap.length;

  const dollars = (s: { shortPct: number; marketCap: number }) =>
    (s.shortPct / 100) * s.marketCap;

  const totalDollarsShorted = withCap.reduce((sum, s) => sum + dollars(s), 0);
  const avgShortPct =
    stocks.length > 0
      ? stocks.reduce((sum, s) => sum + s.shortPct, 0) / stocks.length
      : 0;

  const topByDollars = [...withCap]
    .sort((a, b) => dollars(b) - dollars(a))
    .slice(0, 10)
    .map((s) => ({
      code: s.stockCode,
      name: s.companyName,
      industry: s.industry,
      shortPct: s.shortPct,
      dollarsShorted: dollars(s),
    }));

  const bankBasket = BANK_CODES.flatMap((code) => {
    const s = withCap.find((x) => x.stockCode === code);
    return s
      ? [
          {
            code: s.stockCode,
            name: s.companyName,
            industry: s.industry,
            shortPct: s.shortPct,
            dollarsShorted: dollars(s),
          },
        ]
      : [];
  });
  const bankBasketTotal = bankBasket.reduce(
    (sum, s) => sum + s.dollarsShorted,
    0,
  );

  const byIndustry = new Map<
    string,
    { dollarsShorted: number; stockCount: number; pctSum: number }
  >();
  for (const s of withCap) {
    const key = industryLabel(s.industry) || "Other";
    const entry = byIndustry.get(key) ?? {
      dollarsShorted: 0,
      stockCount: 0,
      pctSum: 0,
    };
    entry.dollarsShorted += dollars(s);
    entry.stockCount += 1;
    entry.pctSum += s.shortPct;
    byIndustry.set(key, entry);
  }
  const industries = [...byIndustry.entries()]
    .map(([industry, e]) => ({
      industry,
      dollarsShorted: e.dollarsShorted,
      stockCount: e.stockCount,
      avgShortPct: e.pctSum / e.stockCount,
    }))
    .sort((a, b) => b.dollarsShorted - a.dollarsShorted)
    .slice(0, 8);

  const movers = stocks.filter((s) => Math.abs(s.shortPctChange4w) > 0.01);
  const toMover = (s: (typeof movers)[number]) => ({
    code: s.stockCode,
    name: s.companyName,
    shortPct: s.shortPct,
    change4w: s.shortPctChange4w,
  });
  const risers = [...movers]
    .sort((a, b) => b.shortPctChange4w - a.shortPctChange4w)
    .slice(0, 5)
    .map(toMover);
  const fallers = [...movers]
    .sort((a, b) => a.shortPctChange4w - b.shortPctChange4w)
    .slice(0, 5)
    .map(toMover);

  return {
    asOfDate,
    totalDollarsShorted,
    stockCount: stocks.length,
    excludedCount,
    avgShortPct,
    stocksAbove10Pct: stocks.filter((s) => s.shortPct >= 10).length,
    stocksAbove5Pct: stocks.filter((s) => s.shortPct >= 5).length,
    topByDollars,
    bankBasket,
    bankBasketTotal,
    industries,
    risers,
    fallers,
  };
}

// ISR-safe: every connect call goes through serverFetchOutsideNextCache (a
// no-store POST through Next's patched fetch throws inside a static render,
// unstable_cache or not; see config.ts), and unstable_cache holds the results.
// 1h TTL; the page is also busted by the daily sync via /api/revalidate.
// Degrades to null so the page can render its static shell if the API is
// down, or if the latest report cannot be read: the figures are withheld
// rather than computed over every screener row. The null also caps the
// reading render at a minute (bailOnEmptyRender), here rather than in each
// page: /statistics, the /press citation and the share card all render a
// no-figures fallback from it, which otherwise stays cached for their whole
// revalidate (an hour; a day for the card).
export async function getShortStatistics(): Promise<ShortStatistics | null> {
  // Build prerenders render the static shell only (skipForBuild is env AND
  // build-phase, so runtime ISR still fetches — see the SKIP_STATIC_GENERATION
  // landmine in CLAUDE.md).
  if (skipForBuild()) return null;
  try {
    // The report's date and codes are read HERE, outside the statistics
    // cache, on purpose: Next 14 runs an unstable_cache callback with
    // fetchCache "force-no-store", and a nested unstable_cache then skips its
    // own entry, so getReportCodes' per-date cache would be bypassed on every
    // recompute. Both are cache hits after the first read of a report.
    const asOfDate = (await getAvailableDates(1)).dates[0];
    if (!asOfDate) throw new Error("no ASIC report date");
    const reportCodes = new Set(await getReportCodes(asOfDate));
    return await unstable_cache(
      async () => {
        const stats = await fetchShortStatistics(asOfDate, reportCodes);
        // Never CACHE emptiness: a zero total means the screener MV came
        // back empty — throwing makes it a cache miss so the next request
        // retries, instead of pinning a "$0" shell for the full TTL.
        if (stats.totalDollarsShorted <= 0) {
          throw new Error("screener returned no rows");
        }
        return stats;
      },
      // Keyed by the report: a new report recomputes at once.
      ["short-statistics-v2", asOfDate],
      { tags: ["short-statistics"], revalidate: 3600 },
    )();
  } catch (err) {
    console.error("[getShortStatistics] failed:", err);
    await bailOnEmptyRender();
    return null;
  }
}
