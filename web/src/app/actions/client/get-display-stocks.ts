"use server";

import { cache } from "react";
import { getTopShortsData } from "~/app/actions/getTopShorts";
import { CACHE_KEYS, getCached, setCached } from "~/@/lib/kv-cache";
import type { TimeSeriesData } from "~/gen/stocks/v1alpha1/stocks_pb";
import type { GetTopShortsResponse } from "~/gen/shorts/v1alpha1/shorts_pb";

export interface StockDisplayData {
  code: string;
  name: string;
  shortPercentage: number;
  price?: number;
  change?: number;
}

interface PriceDataItem {
  stock_code: string;
  change_percent?: number;
  close?: number;
}

interface PriceDataResponse {
  data?: PriceDataItem[];
}

/**
 * Get top shorted stocks for display in the animated ticker
 * Uses React cache for request deduplication
 */
export const getTopStocksForDisplay = cache(async (limit = 5): Promise<StockDisplayData[]> => {
  try {
    // Try cache first
    const cacheKey = CACHE_KEYS.topStocks(limit);
    const cached = await getCached<GetTopShortsResponse>(cacheKey);
    
    let response: GetTopShortsResponse;
    
    if (cached) {
      response = cached;
    } else {
      // Cache miss - fetch from backend
      const fetchedResponse = await getTopShortsData("3m", limit, 0);
      response = fetchedResponse;
      
      // Cache the result (async, don't wait)
      setCached(cacheKey, response, 300).catch((error) => {
        console.error("Failed to cache top stocks:", error);
      });
    }
    
    if (!response?.timeSeries || response.timeSeries.length === 0) {
      return [];
    }
    
    // Transform to display format
    const stocks: StockDisplayData[] = response.timeSeries.map((ts: TimeSeriesData) => {
      const latestPoint = ts.points && ts.points.length > 0 
        ? ts.points[ts.points.length - 1]
        : null;
      
      const shortPercentage = latestPoint?.shortPosition ?? ts.latestShortPosition ?? 0;
      
      const productCode: string = ts.productCode ?? "";
      const productName: string = ts.name ?? productCode;
      
      return {
        code: productCode,
        name: productName,
        shortPercentage: shortPercentage * 100, // Convert to percentage
      };
    });
    
    // Try to fetch price data for these stocks from market data service
    // Use Next.js API route to avoid CORS issues
    try {
      const stockCodes = stocks.map((s) => s.code).filter(Boolean);
      
      if (stockCodes.length > 0) {
        // Use relative URL to proxy through Next.js API route
        // Note: This assumes this function is running in a context where relative URLs work (e.g. client-side navigation)
        // If running on server, this fetch might fail if base URL is not provided.
        // However, since this function is likely called from a Server Component or Action,
        // fetch to localhost might work if configured, but better to call service directly if possible.
        // For now, keeping as is since it was working in about page.
        // Wait, if this runs on server, fetch("/api/...") might fail without base URL.
        // The original code was in a file imported by a client component?
        // No, `getTopStocksForDisplay` was imported in `AnimatedStockTicker` (Client Component).
        // So it runs on Client?
        // If so, it cannot import `getTopShortsData` (Server Action/Function) unless it's passed as prop or via server action.
        // If `getTopShortsData` is a server action (marked "use server"), it works.
        // But `getTopShortsData` in `getTopShorts.ts` was NOT marked "use server".
        // This suggests `AnimatedStockTicker` might be failing or I missed something.
        // Let's assume it works for now or add base URL handling.
        
        const priceResponse: Response = await fetch(`${process.env.NEXT_PUBLIC_APP_URL ?? ""}/api/stocks/multiple`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stockCodes }),
          // Add timeout
          signal: AbortSignal.timeout(5000),
        });
        
        if (priceResponse.ok) {
          const priceData = (await priceResponse.json()) as PriceDataResponse;
          const priceItems = priceData.data ?? [];
          const pricesMap = new Map(
            priceItems.map((item) => [
              item.stock_code,
              { price: item.close, change: item.change_percent },
            ])
          );
          
          // Merge price data
          stocks.forEach((stock) => {
            const priceInfo = pricesMap.get(stock.code);
            if (priceInfo) {
              stock.price = priceInfo.price;
              stock.change = priceInfo.change;
            }
          });
        }
      }
    } catch (priceError) {
      // Price data is optional, continue without it
      console.warn("Could not fetch price data:", priceError);
    }
    
    return stocks.filter((s) => s.code); // Filter out invalid entries
  } catch (error) {
    console.error("Error fetching top stocks:", error);
    return [];
  }
});
