"use client";

import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { StockService } from "~/gen/shorts/v1alpha1/stock_pb";
import { MarketService } from "~/gen/shorts/v1alpha1/market_pb";
import { type GetTopShortsResponse, type ViewMode } from "~/gen/shorts/v1alpha1/market_pb";
import {
  type IndustryTreeMap,
  type Stock,
  type StockDetails,
  type TimeSeriesData,
} from "~/gen/stocks/v1alpha1/stocks_pb";
import { formatPeriodForAPI } from "~/lib/period-utils";
import type { HistoricalDataPoint } from "@/lib/stock-data-service";

/**
 * A date range, YYYY-MM-DD, inclusive; no `from` runs from the first data and
 * no `to` runs to the newest. A chart kept as posted asks for one.
 */
export interface ClientDateWindow {
  from?: string;
  to?: string;
}

/**
 * The codes a windowed read accepts: the chart share page's and the bot's rule
 * (2 to 6 letters or digits), not the live reads' 3 to 4.
 */
const WINDOWED_CODE_RE = /^[A-Za-z0-9]{2,6}$/;

/** A window that cannot hold a session (from after to): nothing to ask for. */
function isEmptyRange(range: ClientDateWindow): boolean {
  return (
    range.from !== undefined &&
    range.to !== undefined &&
    range.from !== "" &&
    range.to !== "" &&
    range.from > range.to
  );
}

/**
 * A connect error that means "no answer", not "try again": the stock is not
 * there, or the request was refused as malformed. Anything else (a 429, a
 * dropped connection, a 5xx) is transient and must reject, so the caller's
 * retry runs and an empty answer is not cached in its place.
 */
function isNoAnswer(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 3 || code === 5) return true; // Connect's InvalidArgument, NotFound
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("invalid_argument") || message.includes("not_found");
}

// Client-side API calls (not using React cache) for use in interactive components like tooltips
// These should only be called from client components

// Use relative URL in browser so requests go through Next.js rewrites (avoids CORS).
// Server-side falls back to direct backend URL.
const getApiUrl = (): string => {
  if (typeof window !== "undefined") {
    return "";
  }
  return (
    process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT ??
    process.env.NEXT_PUBLIC_API_URL ??
    "http://localhost:9091"
  );
};

// Create a shared transport for client-side calls
const getTransport = () =>
  createConnectTransport({
    fetch: fetch,
    baseUrl: getApiUrl(),
  });

/**
 * Validates if a product code meets the backend API requirements
 * Product codes must be 3-4 alphanumeric characters
 */
function isValidProductCode(code: string): boolean {
  return /^[A-Za-z0-9]{3,4}$/.test(code);
}

/**
 * Fetch stock details on the client side (not cached)
 * Use this for interactive components like tooltips
 */
export async function fetchStockDetailsClient(
  productCode: string,
): Promise<StockDetails | undefined> {
  // Validate product code before making API call to avoid 400 errors
  if (!productCode || !isValidProductCode(productCode)) {
    return undefined;
  }

  try {
    const transport = getTransport();
    const client = createClient(StockService, transport);
    const response = await client.getStockDetails({ productCode });
    return response;
  } catch (error) {
    // Only log non-validation errors to avoid console spam
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (
      !errorMessage.includes("invalid_argument") &&
      !errorMessage.includes("not_found")
    ) {
      console.error(`Error fetching stock details for ${productCode}:`, error);
    }
    return undefined;
  }
}

/**
 * Fetch stock summary on the client side.
 */
export async function fetchStockClient(
  productCode: string,
): Promise<Stock | undefined> {
  if (!productCode || !isValidProductCode(productCode)) {
    return undefined;
  }

  try {
    const transport = getTransport();
    const client = createClient(StockService, transport);
    return await client.getStock({ productCode });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (
      !errorMessage.includes("invalid_argument") &&
      !errorMessage.includes("not_found")
    ) {
      console.error(`Error fetching stock summary for ${productCode}:`, error);
    }
    return undefined;
  }
}

/**
 * Fetch stock time series data on the client side (not cached)
 * Use this for interactive components like tooltips
 */
export async function fetchStockDataClient(
  productCode: string,
  period = "1m",
): Promise<TimeSeriesData | undefined> {
  // Validate product code before making API call to avoid 400 errors
  if (!productCode || !isValidProductCode(productCode)) {
    return undefined;
  }

  try {
    const transport = getTransport();
    const client = createClient(StockService, transport);
    const response = await client.getStockData({
      productCode,
      period,
    });
    return response;
  } catch (error) {
    // Only log non-validation errors to avoid console spam
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (
      !errorMessage.includes("invalid_argument") &&
      !errorMessage.includes("not_found")
    ) {
      console.error(`Error fetching stock data for ${productCode}:`, error);
    }
    return undefined;
  }
}

/**
 * Fetch a windowed short series (a chart kept as posted). `period` still picks
 * the bucketing. Answers an empty series for a window that cannot hold a
 * session and for a code or stock the API does not know; a transient failure
 * rejects, so the query retries rather than caching nothing.
 */
export async function fetchStockDataWindowClient(
  productCode: string,
  period: string,
  range: ClientDateWindow,
): Promise<TimeSeriesData> {
  // The chart reads only `points`; an empty series is the same shape with none.
  const empty = () => ({ points: [] }) as unknown as TimeSeriesData;
  if (!WINDOWED_CODE_RE.test(productCode) || isEmptyRange(range)) return empty();

  try {
    const client = createClient(StockService, getTransport());
    return await client.getStockData({
      productCode,
      period,
      from: range.from ?? "",
      to: range.to ?? "",
    });
  } catch (error) {
    if (isNoAnswer(error)) return empty();
    throw error;
  }
}

/**
 * Fetch end-of-day prices for a date range on the client side, as the
 * historical-data shape the charts read. The live chart's prices come from the
 * market-data service, which takes only a period; a chart kept as posted needs
 * its window, so it reads them here. An empty `from` or `to` is left open.
 *
 * Answers [] for a window that cannot hold a session and for a code or stock
 * the API does not know. A transient failure rejects, so the query retries and
 * an empty answer is never cached in its place.
 */
export async function fetchStockPricesClient(
  productCode: string,
  range: ClientDateWindow,
): Promise<HistoricalDataPoint[]> {
  if (!WINDOWED_CODE_RE.test(productCode) || isEmptyRange(range)) return [];

  try {
    const client = createClient(StockService, getTransport());
    const response = await client.getStockPrices({
      productCode,
      from: range.from ?? "",
      to: range.to ?? "",
    });
    return response.points.map((p) => ({
      date: p.date,
      open: p.open,
      high: p.high,
      low: p.low,
      close: p.close,
      volume: Number(p.volume),
      adjustedClose: p.adjustedClose,
    }));
  } catch (error) {
    if (isNoAnswer(error)) return [];
    throw error;
  }
}

/**
 * Fetch top shorts on the client side.
 */
export async function fetchTopShortsClient(
  period: string,
  limit: number,
  offset = 0,
): Promise<GetTopShortsResponse | undefined> {
  try {
    const transport = getTransport();
    const client = createClient(MarketService, transport);
    return await client.getTopShorts({
      period: formatPeriodForAPI(period),
      limit,
      offset,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (!errorMessage.includes("invalid_argument")) {
      console.error("Error fetching top shorts:", error);
    }
    return undefined;
  }
}

/**
 * Fetch industry treemap data on the client side.
 */
export async function fetchIndustryTreeMapClient(
  period: string,
  limit: number,
  viewMode: ViewMode,
): Promise<IndustryTreeMap | undefined> {
  try {
    const transport = getTransport();
    const client = createClient(MarketService, transport);
    return await client.getIndustryTreeMap({
      period: formatPeriodForAPI(period),
      limit,
      viewMode,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (!errorMessage.includes("invalid_argument")) {
      console.error("Error fetching industry treemap:", error);
    }
    return undefined;
  }
}
