"use client";

import { useState, useEffect, useRef } from "react";
import {
  getHistoricalData,
  type HistoricalDataPoint,
} from "@/lib/stock-data-service";
import { type SparklineData } from "@/components/ui/sparkline";

interface UseSparklineDataResult {
  data: SparklineData[] | null;
  loading: boolean;
  error: Error | null;
  isPositive: boolean;
}

// Cache to avoid repeated fetches
const sparklineCache = new Map<string, SparklineData[]>();
const loadingCache = new Set<string>();

/**
 * Custom hook to fetch and format 3-month sparkline data for a stock
 * @param stockCode - The stock code to fetch data for
 * @returns Sparkline data, loading state, error, and trend direction
 */
export function useSparklineData(stockCode: string): UseSparklineDataResult {
  const [data, setData] = useState<SparklineData[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [isPositive, setIsPositive] = useState(false);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!stockCode) {
      setData(null);
      setLoading(false);
      setError(null);
      setIsPositive(false);
      return;
    }

    const cacheKey = `${stockCode}-3m`;

    // Check cache first
    if (sparklineCache.has(cacheKey)) {
      const cachedData = sparklineCache.get(cacheKey)!;
      setData(cachedData);
      setLoading(false);
      setError(null);

      // Calculate trend from cached data
      if (cachedData.length > 0) {
        const firstValue = cachedData[0]?.value ?? 0;
        const lastValue = cachedData[cachedData.length - 1]?.value ?? 0;
        setIsPositive(lastValue >= firstValue);
      }
      return;
    }

    // Check if already loading
    if (loadingCache.has(cacheKey)) {
      return;
    }

    // Fetch data
    const fetchSparklineData = async () => {
      loadingCache.add(cacheKey);
      setLoading(true);
      setError(null);

      try {
        // Use 6 months to ensure we get enough data points
        // (database currently has data up to Aug 2025)
        const historicalData: HistoricalDataPoint[] = await getHistoricalData(
          stockCode,
          "6m",
        );

        if (!isMountedRef.current) return;

        if (!historicalData || historicalData.length === 0) {
          setData(null);
          setLoading(false);
          return;
        }

        // Transform to sparkline format
        const sparklineData: SparklineData[] = historicalData.map((point) => ({
          date: new Date(point.date),
          value: point.close,
        }));

        // Calculate trend
        const firstValue = sparklineData[0]?.value ?? 0;
        const lastValue = sparklineData[sparklineData.length - 1]?.value ?? 0;
        const positive = lastValue >= firstValue;

        // Cache the result
        sparklineCache.set(cacheKey, sparklineData);

        if (isMountedRef.current) {
          setData(sparklineData);
          setIsPositive(positive);
          setError(null);
        }
      } catch (err) {
        if (isMountedRef.current) {
          const error =
            err instanceof Error
              ? err
              : new Error("Failed to fetch sparkline data");
          setError(error);
          setData(null);
        }
      } finally {
        loadingCache.delete(cacheKey);
        if (isMountedRef.current) {
          setLoading(false);
        }
      }
    };

    void fetchSparklineData();
  }, [stockCode]);

  return { data, loading, error, isPositive };
}
