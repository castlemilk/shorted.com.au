import { unstable_cache } from "next/cache";
import {
  buildApiUrl,
  getServerMarketDataApiUrl,
  serverFetchWithUserAgent,
} from "~/app/actions/config";
import { getStockData } from "~/app/actions/getStockData";
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

/** The close series for `period`, or [] on any failure. */
export async function getChartPrices(
  code: string,
  period: string,
): Promise<SeriesPoint[]> {
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

/** The short series for `period`, or [] on any failure. */
export async function getChartShorts(
  code: string,
  period: string,
): Promise<SeriesPoint[]> {
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
