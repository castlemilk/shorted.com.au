"use server";

import { getOrSetCached, CACHE_KEYS, TOP_PAGE_TTL } from "~/@/lib/kv-cache";
import { getTopShortsData } from "../getTopShorts";
import {
  calculateMovers,
  type TimePeriod,
  type MoversData,
} from "~/@/lib/shorts-calculations";
import { toJson } from "@bufbuild/protobuf";
import {
  TimeSeriesDataSchema,
  type TimeSeriesData,
} from "~/gen/stocks/v1alpha1/stocks_pb";
import { siteConfig } from "~/@/config/site";

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
function serializeTimeSeriesData(data: TimeSeriesData): SerializedTimeSeriesData {
  return toJson(TimeSeriesDataSchema, data) as unknown as SerializedTimeSeriesData;
}

/**
 * Serialize movers data for caching
 */
function serializeMoversData(movers: MoversData): SerializedMoversData {
  return {
    biggestGainers: movers.biggestGainers.map((item) => ({
      ...serializeTimeSeriesData(item),
      change: item.change,
    })),
    biggestLosers: movers.biggestLosers.map((item) => ({
      ...serializeTimeSeriesData(item),
      change: item.change,
    })),
    mostVolatile: movers.mostVolatile.map((item) => ({
      ...serializeTimeSeriesData(item),
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

  return getOrSetCached(
    cacheKey,
    async () => {
      // Fetch raw data
      const response = await getTopShortsData(period, limit, 0);
      const rawTimeSeries = response.timeSeries ?? [];

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
    },
    TOP_PAGE_TTL
  );
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
