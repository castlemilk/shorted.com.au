/**
 * Technical Analysis Indicators Library
 * 
 * Provides functions for calculating common technical indicators
 * used in stock analysis and charting.
 */

export type IndicatorType = "SMA" | "WMA" | "EMA";

export interface IndicatorConfig {
  type: IndicatorType;
  period: number;
  stockCode: string;
  color: string;
  enabled: boolean;
}

export interface IndicatorResult {
  config: IndicatorConfig;
  values: (number | null)[];
}

/**
 * Calculate Simple Moving Average (SMA)
 * 
 * SMA = Sum of prices over N periods / N
 * 
 * @param data - Array of price/value data points
 * @param period - Number of periods for the moving average
 * @returns Array with SMA values (null for periods before enough data)
 */
export function calculateSMA(data: number[], period: number): (number | null)[] {
  if (period <= 0 || data.length === 0) {
    return data.map(() => null);
  }

  const result: (number | null)[] = [];
  
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      // Not enough data points yet
      result.push(null);
    } else {
      // Calculate average of last 'period' values
      let sum = 0;
      for (let j = 0; j < period; j++) {
        sum += data[i - j] ?? 0;
      }
      result.push(sum / period);
    }
  }
  
  return result;
}

/**
 * Calculate Weighted Moving Average (WMA)
 * 
 * WMA gives more weight to recent prices.
 * Weight for period i (from most recent) = (period - i + 1)
 * 
 * @param data - Array of price/value data points
 * @param period - Number of periods for the moving average
 * @returns Array with WMA values (null for periods before enough data)
 */
export function calculateWMA(data: number[], period: number): (number | null)[] {
  if (period <= 0 || data.length === 0) {
    return data.map(() => null);
  }

  const result: (number | null)[] = [];
  // Denominator is sum of weights: period + (period-1) + ... + 1 = period * (period + 1) / 2
  const weightSum = (period * (period + 1)) / 2;
  
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      // Not enough data points yet
      result.push(null);
    } else {
      let weightedSum = 0;
      for (let j = 0; j < period; j++) {
        // Most recent value gets highest weight
        const weight = period - j;
        weightedSum += (data[i - j] ?? 0) * weight;
      }
      result.push(weightedSum / weightSum);
    }
  }
  
  return result;
}

/**
 * Calculate Exponential Moving Average (EMA)
 * 
 * EMA = (Price * k) + (Previous EMA * (1 - k))
 * where k = 2 / (period + 1)
 * 
 * Uses SMA for the first value, then EMA formula thereafter.
 * 
 * @param data - Array of price/value data points
 * @param period - Number of periods for the moving average
 * @returns Array with EMA values (null for periods before enough data)
 */
export function calculateEMA(data: number[], period: number): (number | null)[] {
  if (period <= 0 || data.length === 0) {
    return data.map(() => null);
  }

  const result: (number | null)[] = [];
  const multiplier = 2 / (period + 1);
  
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      // Not enough data points yet
      result.push(null);
    } else if (i === period - 1) {
      // First EMA value is the SMA
      let sum = 0;
      for (let j = 0; j < period; j++) {
        sum += data[i - j] ?? 0;
      }
      result.push(sum / period);
    } else {
      // EMA = (Price * k) + (Previous EMA * (1 - k))
      const previousEMA = result[i - 1];
      if (previousEMA !== null && previousEMA !== undefined) {
        const ema = ((data[i] ?? 0) * multiplier) + (previousEMA * (1 - multiplier));
        result.push(ema);
      } else {
        result.push(null);
      }
    }
  }
  
  return result;
}

/**
 * Calculate any indicator based on type
 */
export function calculateIndicator(
  data: number[],
  type: IndicatorType,
  period: number
): (number | null)[] {
  switch (type) {
    case "SMA":
      return calculateSMA(data, period);
    case "WMA":
      return calculateWMA(data, period);
    case "EMA":
      return calculateEMA(data, period);
    default:
      return data.map(() => null);
  }
}

/**
 * Common indicator period presets
 */
export const INDICATOR_PERIODS = [5, 10, 20, 50, 100, 200] as const;

/**
 * Default indicator colors (for multiple indicators)
 */
export const INDICATOR_COLORS = [
  "#f59e0b", // amber-500
  "#8b5cf6", // violet-500
  "#06b6d4", // cyan-500
  "#84cc16", // lime-500
  "#ec4899", // pink-500
  "#14b8a6", // teal-500
] as const;

/**
 * Color palette for multiple stock series
 */
export const STOCK_COLORS = [
  "#3b82f6", // blue-500
  "#ef4444", // red-500
  "#10b981", // emerald-500
  "#f59e0b", // amber-500
  "#8b5cf6", // violet-500
  "#ec4899", // pink-500
  "#06b6d4", // cyan-500
  "#f97316", // orange-500
] as const;

/**
 * Get a color for a stock based on its index
 */
export function getStockColor(index: number): string {
  return STOCK_COLORS[index % STOCK_COLORS.length] ?? "#3b82f6";
}

/**
 * Get a color for an indicator based on its index
 */
export function getIndicatorColor(index: number): string {
  return INDICATOR_COLORS[index % INDICATOR_COLORS.length] ?? "#94a3b8";
}

/**
 * Normalize data to percentage change from first value
 * Useful for comparing stocks with different price ranges
 */
export function normalizeToPercentChange(data: number[]): number[] {
  if (data.length === 0) return [];

  const firstValue = data[0];
  if (firstValue === undefined || firstValue === 0) return data.map(() => 0);

  return data.map(value => ((value - firstValue) / firstValue) * 100);
}
