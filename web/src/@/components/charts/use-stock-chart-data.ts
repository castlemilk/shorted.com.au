"use client";

import { useMemo } from "react";
import { useShortTimeSeries, useHistoricalData } from "@/hooks/use-stock-queries";
import { shortSeriesToPoints, historicalToPoints, mergeByDay } from "./adapters";
import { pearson } from "./correlation";
import type { ChartPoint } from "./types";

export interface StockChartData {
  short: ChartPoint[];
  price: ChartPoint[];
  volume: ChartPoint[];
  /** Pearson correlation of price vs short over the merged period, or null. */
  correlation: number | null;
  /** True while either query is still loading. */
  anyLoading: boolean;
  /** True only when BOTH queries failed (one success → render the partial series). */
  isError: boolean;
}

/**
 * Shared per-stock chart data: fetches short + historical price series and
 * derives volume + price↔short correlation. Used by both the consolidated
 * StockPriceShortChart and the tabbed StockChartPanel so the fetch/derive logic
 * lives in one place.
 */
export function useStockChartData(code: string, period: string): StockChartData {
  const shortQ = useShortTimeSeries(code, period);
  const histQ = useHistoricalData(code, period);

  const short = useMemo(() => shortSeriesToPoints(shortQ.data), [shortQ.data]);
  const { price, volume } = useMemo(
    () => historicalToPoints(histQ.data),
    [histQ.data],
  );

  const correlation = useMemo(() => {
    const merged = mergeByDay(price, short);
    if (merged.length < 3) return null;
    return pearson(
      merged.map((m) => m.a),
      merged.map((m) => m.b),
    );
  }, [price, short]);

  return {
    short,
    price,
    volume,
    correlation,
    anyLoading: shortQ.isLoading || histQ.isLoading,
    isError: shortQ.isError && histQ.isError,
  };
}
