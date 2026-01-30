"use client";

import { useQuery, useQueries } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import {
  getMultipleStockQuotes,
  getHistoricalData,
  getStockPrice,
  type StockQuote,
  type HistoricalDataPoint,
} from "@/lib/stock-data-service";
import { fetchStockDataClient, fetchStockDetailsClient } from "@/lib/client-api";
import { getTopShortsData } from "~/app/actions/getTopShorts";
import { getStock } from "~/app/actions/getStock";
import type { TimeSeriesData } from "~/gen/stocks/v1alpha1/stocks_pb";

/**
 * Hook for fetching multiple stock quotes with automatic deduplication
 * Uses sorted, comma-joined codes as cache key for deduplication
 */
export function useStockQuotes(codes: string[]) {
  return useQuery({
    queryKey: queryKeys.stock.quotes(codes),
    queryFn: () => getMultipleStockQuotes(codes),
    enabled: codes.length > 0,
    staleTime: 30 * 1000, // 30 seconds for quotes (more frequent updates needed)
  });
}

/**
 * Hook for fetching a single stock quote
 */
export function useStockQuote(code: string) {
  return useQuery({
    queryKey: queryKeys.stock.quote(code),
    queryFn: () => getStockPrice(code),
    enabled: !!code,
    staleTime: 30 * 1000,
  });
}

/**
 * Hook for fetching historical market data (prices)
 */
export function useHistoricalData(code: string, period: string) {
  return useQuery({
    queryKey: queryKeys.market.historical(code, period),
    queryFn: () => getHistoricalData(code, period),
    enabled: !!code && !!period,
    staleTime: 5 * 60 * 1000, // 5 minutes for historical data
  });
}

/**
 * Hook for fetching multiple stocks' historical data in parallel
 * Returns an array of query results that can be combined
 */
export function useMultipleHistoricalData(codes: string[], period: string) {
  return useQueries({
    queries: codes.map((code) => ({
      queryKey: queryKeys.market.historical(code, period),
      queryFn: () => getHistoricalData(code, period),
      enabled: !!code && !!period,
      staleTime: 5 * 60 * 1000,
    })),
    combine: (results) => ({
      data: new Map(
        results
          .map((result, index) => [codes[index], result.data] as [string, HistoricalDataPoint[] | undefined])
          .filter((entry): entry is [string, HistoricalDataPoint[]] => entry[1] !== undefined)
      ),
      isLoading: results.some((r) => r.isLoading),
      isError: results.some((r) => r.isError),
      isPending: results.some((r) => r.isPending),
    }),
  });
}

/**
 * Hook for fetching short position time series data
 */
export function useShortTimeSeries(code: string, period: string) {
  return useQuery({
    queryKey: queryKeys.stock.timeSeries(code, period),
    queryFn: () => fetchStockDataClient(code, period),
    enabled: !!code && !!period,
    staleTime: 60 * 1000, // 1 minute
  });
}

/**
 * Hook for fetching multiple short time series in parallel
 */
export function useMultipleShortTimeSeries(codes: string[], period: string) {
  return useQueries({
    queries: codes.map((code) => ({
      queryKey: queryKeys.stock.timeSeries(code, period),
      queryFn: () => fetchStockDataClient(code, period),
      enabled: !!code && !!period,
      staleTime: 60 * 1000,
    })),
    combine: (results) => ({
      data: new Map(
        results
          .map((result, index) => [codes[index], result.data] as [string, TimeSeriesData | undefined])
          .filter((entry): entry is [string, TimeSeriesData] => entry[1] !== undefined)
      ),
      isLoading: results.some((r) => r.isLoading),
      isError: results.some((r) => r.isError),
      isPending: results.some((r) => r.isPending),
    }),
  });
}

/**
 * Hook for fetching stock details (financial data, metadata)
 */
export function useStockDetails(code: string) {
  return useQuery({
    queryKey: queryKeys.stock.details(code),
    queryFn: () => fetchStockDetailsClient(code),
    enabled: !!code,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}

/**
 * Hook for fetching top shorts data
 */
export function useTopShorts(period: string, limit: number) {
  return useQuery({
    queryKey: queryKeys.shorts.top(period, limit),
    queryFn: async () => {
      const result = await getTopShortsData(period, limit, 0);
      return result.timeSeries;
    },
    staleTime: 60 * 1000, // 1 minute
  });
}

/**
 * Hook for fetching a single stock's short position data
 */
export function useStockShortPosition(code: string) {
  return useQuery({
    queryKey: queryKeys.shorts.stock(code),
    queryFn: () => getStock(code),
    enabled: !!code,
    staleTime: 60 * 1000,
  });
}

/**
 * Hook for fetching multiple stocks' short position data
 */
export function useMultipleStockShortPositions(codes: string[]) {
  return useQueries({
    queries: codes.map((code) => ({
      queryKey: queryKeys.shorts.stock(code),
      queryFn: () => getStock(code),
      enabled: !!code,
      staleTime: 60 * 1000,
    })),
    combine: (results) => ({
      data: new Map(
        results
          .map((result, index) => {
            const data = result.data;
            if (!data) return null;
            return [codes[index], data] as [string, typeof data];
          })
          .filter((entry): entry is [string, NonNullable<typeof entry>[1]] => entry !== null)
      ),
      isLoading: results.some((r) => r.isLoading),
      isError: results.some((r) => r.isError),
      isPending: results.some((r) => r.isPending),
    }),
  });
}

/**
 * Combined hook for watchlist data - fetches quotes, historical data, and short positions
 * Optimized to batch requests and deduplicate across widgets
 */
export function useWatchlistData(codes: string[], period: string) {
  const quotes = useStockQuotes(codes);
  const historical = useMultipleHistoricalData(codes, period);
  const shortPositions = useMultipleStockShortPositions(codes);

  return {
    quotes: quotes.data ?? new Map<string, StockQuote>(),
    historicalData: historical.data,
    shortPositions: shortPositions.data,
    isLoading: quotes.isLoading || historical.isLoading || shortPositions.isLoading,
    isError: quotes.isError || historical.isError || shortPositions.isError,
    refetch: async () => {
      await Promise.all([
        quotes.refetch(),
        // Note: historical and shortPositions are useQueries results, which don't have refetch
      ]);
    },
  };
}

/**
 * Combined hook for stock chart data - fetches both market and shorts data
 */
export function useStockChartData(
  codes: string[],
  period: string,
  options: { includeMarket?: boolean; includeShorts?: boolean } = {}
) {
  const { includeMarket = true, includeShorts = true } = options;

  const marketData = useMultipleHistoricalData(
    includeMarket ? codes : [],
    period
  );

  const shortsData = useMultipleShortTimeSeries(
    includeShorts ? codes : [],
    period
  );

  return {
    marketData: marketData.data,
    shortsData: shortsData.data,
    isLoading: marketData.isLoading || shortsData.isLoading,
    isError: marketData.isError || shortsData.isError,
    isPending: marketData.isPending || shortsData.isPending,
  };
}
