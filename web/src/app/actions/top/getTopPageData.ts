"use server";

import {
  CACHE_KEYS,
  TOP_PAGE_TTL,
  deleteCached,
  getCached,
  setCached,
} from "~/@/lib/kv-cache";
import { getTopShortsData } from "../getTopShorts";
import {
  calculateMovers,
  type TimePeriod,
  type MoversData,
} from "~/@/lib/shorts-calculations";
import { type TimeSeriesData } from "~/gen/stocks/v1alpha1/stocks_pb";
import { siteConfig } from "~/@/config/site";
import { isEligibleTopShortsInstrument } from "~/@/lib/top-shorts-filter";

/**
 * Serialized time series point for caching
 */
export interface SerializedTimeSeriesPoint {
  timestamp?: string;
  shortPosition: number;
}

/**
 * Serialized time series data for caching
 */
export interface SerializedTimeSeriesData {
  productCode: string;
  name: string;
  latestShortPosition: number;
  points: SerializedTimeSeriesPoint[];
  max?: SerializedTimeSeriesPoint;
  min?: SerializedTimeSeriesPoint;
}

/**
 * Serialized movers data for caching
 */
export interface SerializedMoversData {
  biggestGainers: Array<SerializedTimeSeriesData & { change: number }>;
  biggestLosers: Array<SerializedTimeSeriesData & { change: number }>;
  mostVolatile: Array<SerializedTimeSeriesData & { volatility: number }>;
}

/**
 * Stock item for SEO structured data
 */
export interface StockListItem {
  productCode: string;
  name: string;
  shortPercentage: number;
  url: string;
  rank: number;
}

/**
 * Complete top page data returned from server action
 */
export interface TopPageData {
  timeSeries: SerializedTimeSeriesData[];
  movers: SerializedMoversData;
  stockListItems: StockListItem[];
  lastUpdated: string;
  period: TimePeriod;
}

/**
 * Serialize TimeSeriesData to plain object for caching
 */
function toFiniteNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function serializeTimestamp(value: unknown): string | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object" && "seconds" in value) {
    const timestamp = value as { seconds?: bigint | number | string; nanos?: number };
    const seconds = Number(timestamp.seconds ?? 0);
    if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
    const nanos = Number(timestamp.nanos ?? 0);
    return new Date(seconds * 1000 + nanos / 1000000).toISOString();
  }
  return undefined;
}

function serializeTimeSeriesPoint(point: unknown): SerializedTimeSeriesPoint {
  const raw =
    point && typeof point === "object"
      ? (point as { timestamp?: unknown; shortPosition?: unknown })
      : {};
  return {
    timestamp: serializeTimestamp(raw.timestamp),
    shortPosition: toFiniteNumber(raw.shortPosition),
  };
}

function serializeTimeSeriesData(data: TimeSeriesData): SerializedTimeSeriesData {
  const raw = data as TimeSeriesData & {
    points?: unknown[];
    max?: unknown;
    min?: unknown;
    latestShortPosition?: unknown;
    percentageShorted?: unknown;
  };
  const points = Array.isArray(raw.points)
    ? raw.points.map(serializeTimeSeriesPoint)
    : [];

  return {
    productCode: raw.productCode ?? "",
    name: raw.name ?? raw.productCode ?? "",
    latestShortPosition: toFiniteNumber(
      raw.latestShortPosition ?? raw.percentageShorted,
    ),
    points,
    max: raw.max ? serializeTimeSeriesPoint(raw.max) : undefined,
    min: raw.min ? serializeTimeSeriesPoint(raw.min) : undefined,
  };
}

/**
 * Serialize movers data for caching.
 * MoversData already contains plain serializable objects (no protobuf bigint),
 * so we just map the shape to match SerializedMoversData.
 */
function serializeMoversData(movers: MoversData): SerializedMoversData {
  const serializeStock = (s: { productCode: string; name: string; latestShortPosition: number; points: Array<{ shortPosition: number }> }): SerializedTimeSeriesData => ({
    productCode: s.productCode,
    name: s.name,
    latestShortPosition: s.latestShortPosition,
    points: s.points.map((p) => ({ shortPosition: p.shortPosition })),
  });

  return {
    biggestGainers: movers.biggestGainers.map((item) => ({
      ...serializeStock(item),
      change: item.change,
    })),
    biggestLosers: movers.biggestLosers.map((item) => ({
      ...serializeStock(item),
      change: item.change,
    })),
    mostVolatile: movers.mostVolatile.map((item) => ({
      ...serializeStock(item),
      volatility: item.volatility,
    })),
  };
}

/**
 * Generate stock list items for SEO structured data
 */
function generateStockListItems(
  timeSeries: SerializedTimeSeriesData[],
  limit = 20
): StockListItem[] {
  return timeSeries.slice(0, limit).map((stock, index) => ({
    productCode: stock.productCode,
    name: stock.name || stock.productCode,
    shortPercentage: stock.latestShortPosition,
    url: `${siteConfig.url}/shorts/${stock.productCode}`,
    rank: index + 1,
  }));
}

/**
 * Get the last updated timestamp from the data
 */
function getLastUpdatedTimestamp(timeSeries: SerializedTimeSeriesData[]): string {
  if (!timeSeries.length) return new Date().toISOString();

  // Find the most recent timestamp across all time series
  let latestTimestamp = 0;

  for (const series of timeSeries) {
    if (series.points && series.points.length > 0) {
      const lastPoint = series.points[series.points.length - 1];
      if (lastPoint?.timestamp) {
        const ts = new Date(lastPoint.timestamp).getTime();
        if (ts > latestTimestamp) {
          latestTimestamp = ts;
        }
      }
    }
  }

  return latestTimestamp > 0
    ? new Date(latestTimestamp).toISOString()
    : new Date().toISOString();
}

function isUsableTopPageData(data: TopPageData | null): data is TopPageData {
  return (
    !!data &&
    Array.isArray(data.timeSeries) &&
    data.timeSeries.some(
      (stock) =>
        !!stock?.productCode && toFiniteNumber(stock.latestShortPosition) > 0,
    ) &&
    data.timeSeries.every(isEligibleTopShortsInstrument) &&
    data.stockListItems.every(isEligibleTopShortsInstrument) &&
    data.movers.biggestGainers.every(isEligibleTopShortsInstrument) &&
    data.movers.biggestLosers.every(isEligibleTopShortsInstrument) &&
    data.movers.mostVolatile.every(isEligibleTopShortsInstrument)
  );
}

async function buildTopPageData(
  period: TimePeriod,
  limit: number,
): Promise<TopPageData> {
  // Fetch raw data
  const response = await getTopShortsData(period, limit, 0);
  const rawTimeSeries = (response?.timeSeries ?? []).filter(
    isEligibleTopShortsInstrument,
  );

  // Calculate movers from raw data (before serialization)
  const rawMovers = calculateMovers(rawTimeSeries, period);

  // Serialize for caching
  const timeSeries = rawTimeSeries.map(serializeTimeSeriesData);
  const movers = serializeMoversData(rawMovers);

  // Generate SEO items for structured data
  const stockListItems = generateStockListItems(timeSeries, 20);

  // Get last updated timestamp
  const lastUpdated = getLastUpdatedTimestamp(timeSeries);

  return {
    timeSeries,
    movers,
    stockListItems,
    lastUpdated,
    period,
  };
}

/**
 * Fetches all data needed for the /top page with Redis caching.
 * Combines getTopShortsData + calculateMovers into a single cached response.
 *
 * @param period - Time period for analysis ("1m", "3m", "6m", "1y")
 * @param limit - Number of stocks to fetch (default 100)
 * @returns Complete top page data including time series, movers, and SEO items
 */
export async function getTopPageData(
  period: TimePeriod = "3m",
  limit = 100
): Promise<TopPageData> {
  const cacheKey = CACHE_KEYS.topPageData(period, limit);

  const cached = await getCached<TopPageData>(cacheKey);
  if (isUsableTopPageData(cached)) {
    return cached;
  }
  if (cached !== null) {
    await deleteCached(cacheKey);
  }

  const pageData = await buildTopPageData(period, limit);
  if (isUsableTopPageData(pageData)) {
    setCached(cacheKey, pageData, TOP_PAGE_TTL).catch((error) => {
      console.error(`Failed to cache top page data for key ${cacheKey}:`, error);
    });
  }

  return pageData;
}

/**
 * Client-callable version for period changes.
 * Uses the same caching mechanism.
 */
export async function getTopPageDataForPeriod(
  period: TimePeriod
): Promise<TopPageData> {
  return getTopPageData(period, 100);
}
