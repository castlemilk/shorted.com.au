import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { unstable_cache } from "next/cache";
import {
  SHORTS_API_URL,
  buildApiUrl,
  getServerMarketDataApiUrl,
  serverFetchOutsideNextCache,
  serverFetchWithUserAgent,
} from "~/app/actions/config";
import { getStockData } from "~/app/actions/getStockData";
import { StockService } from "~/gen/shorts/v1alpha1/stock_pb";
import {
  anchoredWindows,
  isIsoDay,
  isSettledAnchor,
  sydneyDay,
  type ChartAnchor,
  type DateWindow,
} from "~/@/components/charts/chart-anchor";
import type { ChartPeriod } from "~/@/components/charts/chart-views";
import { formatPeriodForAPI } from "~/lib/period-utils";
import {
  pricePointsFromResponse,
  shortPointsFromSeries,
  type SeriesPoint,
} from "~/@/lib/og/chart-image";

/** Prices are end of day; the image is regenerated well inside a day. */
const PRICES_CACHE_SECONDS = 86400;

/**
 * GetHistoricalPrices, fetched as /api/market-data/historical fetches it (the
 * direct market-data origin, SSR-marked). Not shared with that route: its
 * source is pinned by serverApiSurface.test.ts. The revalidation tag is the
 * route's, so revalidating a stock's prices refreshes both.
 */
async function fetchPrices(
  stockCode: string,
  period: string,
): Promise<unknown> {
  const response = await serverFetchWithUserAgent(
    buildApiUrl(
      getServerMarketDataApiUrl(),
      "/marketdata.v1.MarketDataService/GetHistoricalPrices",
    ),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
      },
      body: JSON.stringify({ stockCode, period }),
      cache: "no-store",
    },
  );
  if (response.status === 400 || response.status === 404) return { prices: [] };
  if (!response.ok) {
    // Thrown, not cached: a transient failure must not pin an empty chart.
    throw new Error(
      `Market data API responded with status: ${response.status}`,
    );
  }
  return (await response.json()) as unknown;
}

/** A settled anchor's picture never changes: its data is cached for a week. */
const SETTLED_REVALIDATE_SECONDS = 7 * 86400;
/** A chart still gaining figures is re-read hourly. */
const RECENT_REVALIDATE_SECONDS = 3600;

/**
 * Whether a window cannot hold a session: from after to. The stock service
 * answers such a window with nothing, so it is never asked.
 */
export function isEmptyWindow(range: DateWindow): boolean {
  return range.from !== undefined && range.from > range.to;
}

/** The data cache's lifetime for an anchored read, decided on the Sydney day. */
export function anchoredRevalidate(anchor: ChartAnchor, now: Date): number {
  return isSettledAnchor(anchor, sydneyDay(now))
    ? SETTLED_REVALIDATE_SECONDS
    : RECENT_REVALIDATE_SECONDS;
}

function stockClient() {
  return createClient(
    StockService,
    createConnectTransport({
      fetch: serverFetchOutsideNextCache,
      baseUrl: SHORTS_API_URL,
    }),
  );
}

/**
 * The short series for a window, as the stock service answers it. Cached only
 * when a read answers points: a read that throws (or answers nothing) is
 * re-asked on the next render, so a failure is never stored.
 */
function readAnchoredShorts(
  code: string,
  period: ChartPeriod,
  range: DateWindow,
  revalidate: number,
): Promise<SeriesPoint[]> {
  if (isEmptyWindow(range)) return Promise.resolve([]);
  return unstable_cache(
    async () => {
      const points = shortPointsFromSeries(
        await stockClient().getStockData({
          productCode: code,
          period: formatPeriodForAPI(period),
          from: range.from ?? "",
          to: range.to,
        }),
      );
      if (points.length === 0) throw new Error("no short positions in window");
      return points;
    },
    ["chart-image", "anchored-shorts", code, period, range.from ?? "", range.to],
    { tags: [`chart-anchored:${code}`], revalidate },
  )();
}

/** The close series for a window, cached only when it answers points. */
function readAnchoredPrices(
  code: string,
  range: DateWindow,
  revalidate: number,
): Promise<SeriesPoint[]> {
  if (isEmptyWindow(range)) return Promise.resolve([]);
  return unstable_cache(
    async () => {
      const response = await stockClient().getStockPrices({
        productCode: code,
        from: range.from ?? "",
        to: range.to,
      });
      // The close, as the live chart draws it; a day is its calendar date.
      const points = pricePointsFromResponse({
        prices: response.points.map((p) => ({ date: p.date, close: p.close })),
      });
      if (points.length === 0) throw new Error("no prices in window");
      return points;
    },
    ["chart-image", "anchored-prices", code, range.from ?? "", range.to],
    { tags: [`chart-anchored:${code}`], revalidate },
  )();
}

/** How long the newest close on or before a day is trusted. */
const NEWEST_CLOSE_SECONDS = 900;

/**
 * The stock's newest close on or before `day` (YYYY-MM-DD), or null when it
 * has none or the read failed. The Discord bot reads it before it draws a new
 * kept post, records it as the anchor's `prices`, and draws the card for that
 * anchor, so the posted card and every redraw read the same windows. Two
 * points are asked for: thinning keeps the first and the last, and the last
 * is the newest. A failure throws inside the cache, so it is never stored.
 */
export async function getNewestClose(
  code: string,
  day: string,
): Promise<string | null> {
  try {
    return await unstable_cache(
      async () => {
        const response = await stockClient().getStockPrices({
          productCode: code,
          to: day,
          maxPoints: 2,
        });
        // A NULL close comes back as 0: that session has no price, so it is no
        // newest close (the card and the live path skip such points too).
        const newest = response.points
          .filter((p) => p.close > 0)
          .map((p) => p.date)
          .filter((d) => isIsoDay(d) && d <= day)
          .sort()
          .pop();
        if (!newest) throw new Error("no close on or before the day");
        return newest;
      },
      ["chart-image", "newest-close", code, day],
      { tags: [`chart-anchored:${code}`], revalidate: NEWEST_CLOSE_SECONDS },
    )();
  } catch (err) {
    console.error(`[chart-image] newest close failed for ${code} ${day}:`, err);
    return null;
  }
}

/**
 * The close series for `period`, or [] on any failure. Kept as posted (an
 * anchor), the window is counted back from the newest close and ends on it.
 */
export async function getChartPrices(
  code: string,
  period: ChartPeriod,
  anchor?: ChartAnchor | null,
): Promise<SeriesPoint[]> {
  if (anchor) {
    try {
      return await readAnchoredPrices(
        code,
        anchoredWindows(period, anchor).prices,
        anchoredRevalidate(anchor, new Date()),
      );
    } catch (err) {
      console.error(`[chart-image] anchored prices failed for ${code} ${period}:`, err);
      return [];
    }
  }
  try {
    const data = await unstable_cache(
      () => fetchPrices(code, period),
      ["chart-image", "historical", code, period],
      {
        tags: ["market-data", `market-historical:${code}:${period}`],
        revalidate: PRICES_CACHE_SECONDS,
      },
    )();
    return pricePointsFromResponse(data);
  } catch (err) {
    console.error(`[chart-image] prices failed for ${code} ${period}:`, err);
    return [];
  }
}

/**
 * The short series for `period`, or [] on any failure. Kept as posted (an
 * anchor), the window ends on the newest report the chart showed.
 */
export async function getChartShorts(
  code: string,
  period: ChartPeriod,
  anchor?: ChartAnchor | null,
): Promise<SeriesPoint[]> {
  if (anchor) {
    try {
      return await readAnchoredShorts(
        code,
        period,
        anchoredWindows(period, anchor).shorts,
        anchoredRevalidate(anchor, new Date()),
      );
    } catch (err) {
      console.error(`[chart-image] anchored short series failed for ${code} ${period}:`, err);
      return [];
    }
  }
  try {
    return shortPointsFromSeries(await getStockData(code, period));
  } catch (err) {
    console.error(
      `[chart-image] short series failed for ${code} ${period}:`,
      err,
    );
    return [];
  }
}

/**
 * `promise`, or `fallback` once `ms` has passed. A share fetch has a crawler
 * waiting on it; a slow read draws the card without that series rather than
 * running into maxDuration.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise.catch(() => fallback), timeout]).finally(() =>
    clearTimeout(timer),
  );
}
