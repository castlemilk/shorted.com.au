"use client";

import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";
import {
  type StockDetails,
  type TimeSeriesData,
} from "~/gen/stocks/v1alpha1/stocks_pb";

// Client-side API calls (not using React cache) for use in interactive components like tooltips
// These should only be called from client components

// Use the same endpoint resolution as server-side actions
const getApiUrl = (): string => {
  // In browser, use NEXT_PUBLIC env var or default to localhost:9091
  if (typeof window !== "undefined") {
    return (
      process.env.NEXT_PUBLIC_API_URL ??
      process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT ??
      "http://localhost:9091"
    );
  }
  // Fallback for SSR (shouldn't be called but just in case)
  return "http://localhost:9091";
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
    const client = createClient(ShortedStocksService, transport);
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
    const client = createClient(ShortedStocksService, transport);
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
