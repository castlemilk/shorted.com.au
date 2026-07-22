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
