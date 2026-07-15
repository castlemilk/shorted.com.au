import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { unstable_cache } from "next/cache";
import {
  ShortedStocksService,
  ScreenerSortField,
  SortDirection,
} from "~/gen/shorts/v1alpha1/shorts_pb";
import {
  SHORTS_API_URL,
  serverFetchWithUserAgent,
  skipForBuild,
} from "./config";

// Aggregate market-wide short-selling statistics for /statistics — the
// citable numbers journalists currently pull from competitors' JS-only
// charts, published here as crawlable server-rendered text.
//
// Dollar-value estimate: short % and market cap both derive from issued
// shares × price, so $ shorted = short_pct/100 × market_cap. Rows without a
// market cap are excluded from dollar sums (counted in excludedCount).

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

async function fetchShortStatistics(): Promise<ShortStatistics> {
  const transport = createConnectTransport({
    fetch: serverFetchWithUserAgent,
    baseUrl: SHORTS_API_URL,
  });
  const client = createClient(ShortedStocksService, transport);

  // Full screener universe (equities only — the MV excludes ETFs/bonds per
  // migration 000043). The API validates limit <= 200, so paginate until
  // totalCount is covered (hard cap 15 pages ≈ 3,000 rows as a backstop).
  const PAGE = 200;
  const firstPagePromise = client.screenStocks({
    sortField: ScreenerSortField.SHORT_PCT,
    sortDirection: SortDirection.DESC,
    limit: PAGE,
    offset: 0,
  });
  const [firstPage, dates] = await Promise.all([
    firstPagePromise,
    client.getAvailableDates({ limit: 1, before: "" }),
  ]);
  const allRows = [...(firstPage.stocks ?? [])];
  const totalCount = firstPage.totalCount ?? allRows.length;
  for (
    let offset = PAGE;
    offset < totalCount && offset < PAGE * 15;
    offset += PAGE
  ) {
    const page = await client.screenStocks({
      sortField: ScreenerSortField.SHORT_PCT,
      sortDirection: SortDirection.DESC,
      limit: PAGE,
      offset,
    });
    if (!page.stocks?.length) break;
    allRows.push(...page.stocks);
  }

  const stocks = allRows.filter((s) => s.shortPct > 0);
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
    const key = s.industry?.trim() || "Other";
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
    asOfDate: dates.dates[0] ?? "",
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

// ISR-safe: the connect call runs inside unstable_cache (same proven pattern
// as getReportsList — fetches inside unstable_cache don't trip the
// no-store-POST-throws-in-ISR landmine). 1h TTL; the page is also busted by
// the daily sync via /api/revalidate. Degrades to null so the page can render
// its static shell if the API is down.
export async function getShortStatistics(): Promise<ShortStatistics | null> {
  // Build prerenders render the static shell only (skipForBuild is env AND
  // build-phase, so runtime ISR still fetches — see the SKIP_STATIC_GENERATION
  // landmine in CLAUDE.md).
  if (skipForBuild()) return null;
  try {
    const stats = await unstable_cache(
      () => fetchShortStatistics(),
      ["short-statistics-v1"],
      { tags: ["short-statistics"], revalidate: 3600 },
    )();
    // A zero total means the screener MV came back empty — treat as
    // unavailable rather than publishing a citable "$0".
    return stats.totalDollarsShorted > 0 ? stats : null;
  } catch (err) {
    console.error("[getShortStatistics] failed:", err);
    return null;
  }
}
