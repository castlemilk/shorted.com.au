import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { StockService } from "~/gen/shorts/v1alpha1/stock_pb";
import { cache } from "react";
import { unstable_cache } from "next/cache";
import { SHORTS_API_URL, serverFetchOutsideNextCache } from "./config";
import { withRetryAndNotFound } from "./withRetry";
import {
  STOCK_PAGE_CACHE_SECONDS,
  normalizeStockPageCacheCode,
  stockPageCacheTags,
} from "./stockPageCache";

/** One ASIC report: its date and the percentage of shares reported short. */
export interface DailyShortPoint {
  /** The report date, YYYY-MM-DD. */
  date: string;
  pct: number;
}

/**
 * A stock's complete short-position record, one point per ASIC report, oldest
 * first.
 *
 * This is the series to compute FROM. getStockData's long periods (5Y, 10Y,
 * MAX) are weekly averages, the right shape for a chart and the wrong one for
 * a figure: the latest point is a week's mean labelled with its Monday, a
 * peak is flattened into its week, and every trailing-window change is taken
 * between two means. On WBT that put the all-time high at 8.75% against the
 * 8.91% ASIC reported on 1 February 2024.
 *
 * Fetched straight from the API, not the edge read: /edge/v1/stock/{code}/data
 * forwards only `period`, so it would drop full_resolution and serve the
 * weekly buckets under this name. Cached as date and percentage only, which is
 * a fifth of the full point and all that the figures use.
 *
 * Resolves to [] when the series is unavailable; callers omit what they
 * cannot compute.
 */
export const getDailyShortSeries = cache(
  async (productCode: string): Promise<DailyShortPoint[]> =>
    (await fetchCached(productCode)) ?? [],
);

const fetchCached = withRetryAndNotFound(
  async (productCode: string): Promise<DailyShortPoint[]> => {
    const code = normalizeStockPageCacheCode(productCode);
    return unstable_cache(
      async () => toDailyPoints(await fetchFullResolution(code)),
      ["stock-daily-short-series", code],
      {
        tags: stockPageCacheTags("stock-daily-series", code),
        revalidate: STOCK_PAGE_CACHE_SECONDS,
      },
    )();
  },
);

async function fetchFullResolution(productCode: string) {
  const transport = createConnectTransport({
    fetch: serverFetchOutsideNextCache,
    baseUrl: SHORTS_API_URL,
  });
  const client = createClient(StockService, transport);
  return client.getStockData({
    productCode,
    period: "max",
    fullResolution: true,
  });
}

/**
 * Reduces API points to dated percentages: undated or non-numeric points are
 * dropped, one point is kept per date (the last), and the result is sorted.
 * Accepts both wire shapes of a timestamp: a protobuf Timestamp (seconds as a
 * bigint or number) and an ISO string.
 */
export function toDailyPoints(
  series: { points?: Array<{ timestamp?: unknown; shortPosition?: unknown }> } | undefined,
): DailyShortPoint[] {
  const byDate = new Map<string, number>();
  for (const p of series?.points ?? []) {
    const date = isoDate(p.timestamp);
    const pct = typeof p.shortPosition === "number" ? p.shortPosition : Number.NaN;
    if (date && Number.isFinite(pct)) byDate.set(date, pct);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, pct]) => ({ date, pct }));
}

function isoDate(value: unknown): string | null {
  let ms: number | null = null;
  if (typeof value === "string") {
    ms = new Date(value).getTime();
  } else if (value && typeof value === "object" && "seconds" in value) {
    const seconds = Number((value as { seconds?: bigint | number | string }).seconds ?? 0);
    ms = seconds > 0 ? seconds * 1000 : null;
  }
  if (ms === null || !Number.isFinite(ms)) return null;
  // Report dates are stored at midnight UTC, so the UTC date is the report date.
  return new Date(ms).toISOString().slice(0, 10);
}

/** A report date as a Date at midnight UTC. */
export function reportDate(point: DailyShortPoint): Date {
  return new Date(`${point.date}T00:00:00Z`);
}
