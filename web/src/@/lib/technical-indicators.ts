/**
 * Technical Analysis Indicators Library
 *
 * Provides functions for calculating common technical indicators
 * used in stock analysis and charting.
 *
 * Extended to support advanced analysis including momentum, volatility,
 * trend, statistical, and volume indicators.
 */

import {
  type IndicatorName,
  calculateIndicatorByName,
  toFloat64Array,
  toNullableArray,
} from "./time-series-analysis";

// ============================================================================
// Indicator Types
// ============================================================================

/**
 * All supported indicator types
 */
export type IndicatorType =
  // Moving Averages
  | "SMA"
  | "WMA"
  | "EMA"
  | "DEMA"
  | "TEMA"
  // Momentum
  | "RSI"
  | "MACD"
  | "STOCH"
  | "WILLR"
  | "ROC"
  | "MOM"
  // Volatility
  | "BBANDS"
  | "ATR"
  | "STDDEV"
  | "HVOL"
  | "KELT"
  // Trend
  | "TRIX"
  | "ADX"
  | "PSAR"
  // Statistical
  | "CORR"
  | "LINREG"
  | "ZSCORE"
  | "DIFF"
  | "CUMRET"
  // Volume
  | "OBV"
  | "VWAP"
  | "VOLSMA";

/**
 * Indicator categories for UI organization
 */
export type IndicatorCategory =
  | "Moving Averages"
  | "Momentum"
  | "Volatility"
  | "Trend"
  | "Statistical"
  | "Volume";

/**
 * Data source for indicator calculation
 */
export type IndicatorDataSource = "shorts" | "market";

/**
 * Extended indicator configuration
 */
export interface IndicatorConfig {
  type: IndicatorType;
  period: number;
  stockCode: string;
  color: string;
  enabled: boolean;
  /** Which data series to analyze */
  dataSource?: IndicatorDataSource;
  /** Additional parameters (e.g., MACD fast/slow/signal periods) */
  params?: {
    fastPeriod?: number;
    slowPeriod?: number;
    signalPeriod?: number;
    stdDevMultiplier?: number;
    dPeriod?: number;
  };
  /** Which output to display for multi-output indicators */
  outputKey?: "primary" | "upper" | "lower" | "signal" | "histogram" | "middle" | "percentK" | "percentD" | "plusDI" | "minusDI";
  /** Custom label override */
  label?: string;
}

/**
 * Multi-output indicator result
 */
export interface MultiOutputIndicator {
  primary: (number | null)[];
  upper?: (number | null)[];
  lower?: (number | null)[];
  signal?: (number | null)[];
  histogram?: (number | null)[];
  middle?: (number | null)[];
  percentK?: (number | null)[];
  percentD?: (number | null)[];
  plusDI?: (number | null)[];
  minusDI?: (number | null)[];
}

/**
 * Result with both single and multi-output support
 */
export interface IndicatorResult {
  config: IndicatorConfig;
  values: (number | null)[];
  multiOutput?: MultiOutputIndicator;
}

/**
 * Indicator metadata for UI
 */
export interface IndicatorMetadata {
  type: IndicatorType;
  name: string;
  shortName: string;
  description: string;
  category: IndicatorCategory;
  defaultPeriod: number;
  hasMultipleOutputs: boolean;
  isOscillator: boolean;
  /** Whether this indicator requires OHLCV data (market data only) */
  requiresOHLCV: boolean;
  /** Whether this indicator requires volume data */
  requiresVolume: boolean;
  /** Default parameters for complex indicators */
  defaultParams?: IndicatorConfig["params"];
  /** Output keys for multi-output indicators */
  outputKeys?: string[];
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
 * Calculate any indicator based on type (legacy wrapper)
 */
export function calculateIndicator(
  data: number[],
  type: IndicatorType,
  period: number
): (number | null)[] {
  // Use legacy implementations for basic moving averages (for compatibility)
  switch (type) {
    case "SMA":
      return calculateSMA(data, period);
    case "WMA":
      return calculateWMA(data, period);
    case "EMA":
      return calculateEMA(data, period);
    default:
      // Use new library for advanced indicators
      const result = calculateAdvancedIndicator(data, { type, period, stockCode: "", color: "", enabled: true });
      return result.values;
  }
}

/**
 * Calculate indicator with full configuration support
 * Returns IndicatorResult with multi-output support
 */
export function calculateAdvancedIndicator(
  data: number[],
  config: IndicatorConfig,
  ohlcv?: { high?: number[]; low?: number[]; volume?: number[] }
): IndicatorResult {
  const float64Data = toFloat64Array(data);

  // Build params for the calculation
  const params: Parameters<typeof calculateIndicatorByName>[2] = {
    period: config.period,
    ...config.params,
  };

  // Add OHLCV data if available
  if (ohlcv?.high) params.high = toFloat64Array(ohlcv.high);
  if (ohlcv?.low) params.low = toFloat64Array(ohlcv.low);
  if (ohlcv?.volume) params.volume = toFloat64Array(ohlcv.volume);

  const output = calculateIndicatorByName(
    config.type as IndicatorName,
    float64Data,
    params
  );

  // Convert to nullable arrays
  const result: IndicatorResult = {
    config,
    values: toNullableArray(output.primary),
  };

  // Add multi-output if applicable
  const metadata = INDICATOR_METADATA[config.type];
  if (metadata?.hasMultipleOutputs) {
    result.multiOutput = {
      primary: toNullableArray(output.primary),
    };
    if (output.upper) result.multiOutput.upper = toNullableArray(output.upper);
    if (output.lower) result.multiOutput.lower = toNullableArray(output.lower);
    if (output.signal) result.multiOutput.signal = toNullableArray(output.signal);
    if (output.histogram) result.multiOutput.histogram = toNullableArray(output.histogram);
    if (output.middle) result.multiOutput.middle = toNullableArray(output.middle);
    if (output.percentK) result.multiOutput.percentK = toNullableArray(output.percentK);
    if (output.percentD) result.multiOutput.percentD = toNullableArray(output.percentD);
    if (output.plusDI) result.multiOutput.plusDI = toNullableArray(output.plusDI);
    if (output.minusDI) result.multiOutput.minusDI = toNullableArray(output.minusDI);

    // Set primary values based on outputKey
    if (config.outputKey && result.multiOutput[config.outputKey]) {
      result.values = result.multiOutput[config.outputKey]!;
    }
  }

  return result;
}

/**
 * Common indicator period presets
 */
export const INDICATOR_PERIODS = [5, 10, 14, 20, 50, 100, 200] as const;

/**
 * Indicator metadata registry
 */
export const INDICATOR_METADATA: Record<IndicatorType, IndicatorMetadata> = {
  // Moving Averages
  SMA: {
    type: "SMA",
    name: "Simple Moving Average",
    shortName: "SMA",
    description: "Average of closing prices over a period",
    category: "Moving Averages",
    defaultPeriod: 20,
    hasMultipleOutputs: false,
    isOscillator: false,
    requiresOHLCV: false,
    requiresVolume: false,
  },
  WMA: {
    type: "WMA",
    name: "Weighted Moving Average",
    shortName: "WMA",
    description: "Moving average with more weight on recent prices",
    category: "Moving Averages",
    defaultPeriod: 20,
    hasMultipleOutputs: false,
    isOscillator: false,
    requiresOHLCV: false,
    requiresVolume: false,
  },
  EMA: {
    type: "EMA",
    name: "Exponential Moving Average",
    shortName: "EMA",
    description: "Exponentially weighted moving average",
    category: "Moving Averages",
    defaultPeriod: 20,
    hasMultipleOutputs: false,
    isOscillator: false,
    requiresOHLCV: false,
    requiresVolume: false,
  },
  DEMA: {
    type: "DEMA",
    name: "Double EMA",
    shortName: "DEMA",
    description: "Faster trend-following than EMA",
    category: "Moving Averages",
    defaultPeriod: 20,
    hasMultipleOutputs: false,
    isOscillator: false,
    requiresOHLCV: false,
    requiresVolume: false,
  },
  TEMA: {
    type: "TEMA",
    name: "Triple EMA",
    shortName: "TEMA",
    description: "Even faster trend-following than DEMA",
    category: "Moving Averages",
    defaultPeriod: 20,
    hasMultipleOutputs: false,
    isOscillator: false,
    requiresOHLCV: false,
    requiresVolume: false,
  },
  // Momentum
  RSI: {
    type: "RSI",
    name: "Relative Strength Index",
    shortName: "RSI",
    description: "Momentum oscillator (0-100). Overbought >70, Oversold <30",
    category: "Momentum",
    defaultPeriod: 14,
    hasMultipleOutputs: false,
    isOscillator: true,
    requiresOHLCV: false,
    requiresVolume: false,
  },
  MACD: {
    type: "MACD",
    name: "MACD",
    shortName: "MACD",
    description: "Trend momentum with signal line crossovers",
    category: "Momentum",
    defaultPeriod: 12,
    hasMultipleOutputs: true,
    isOscillator: false,
    requiresOHLCV: false,
    requiresVolume: false,
    defaultParams: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
    outputKeys: ["primary", "signal", "histogram"],
  },
  STOCH: {
    type: "STOCH",
    name: "Stochastic Oscillator",
    shortName: "Stoch",
    description: "Momentum with overbought/oversold zones (0-100)",
    category: "Momentum",
    defaultPeriod: 14,
    hasMultipleOutputs: true,
    isOscillator: true,
    requiresOHLCV: false,
    requiresVolume: false,
    defaultParams: { dPeriod: 3 },
    outputKeys: ["percentK", "percentD"],
  },
  WILLR: {
    type: "WILLR",
    name: "Williams %R",
    shortName: "%R",
    description: "Overbought/oversold oscillator (-100 to 0)",
    category: "Momentum",
    defaultPeriod: 14,
    hasMultipleOutputs: false,
    isOscillator: true,
    requiresOHLCV: false,
    requiresVolume: false,
  },
  ROC: {
    type: "ROC",
    name: "Rate of Change",
    shortName: "ROC",
    description: "Price momentum as percentage change",
    category: "Momentum",
    defaultPeriod: 12,
    hasMultipleOutputs: false,
    isOscillator: false,
    requiresOHLCV: false,
    requiresVolume: false,
  },
  MOM: {
    type: "MOM",
    name: "Momentum",
    shortName: "MOM",
    description: "Simple price difference over period",
    category: "Momentum",
    defaultPeriod: 10,
    hasMultipleOutputs: false,
    isOscillator: false,
    requiresOHLCV: false,
    requiresVolume: false,
  },
  // Volatility
  BBANDS: {
    type: "BBANDS",
    name: "Bollinger Bands",
    shortName: "BB",
    description: "Volatility bands around SMA (±2 std dev)",
    category: "Volatility",
    defaultPeriod: 20,
    hasMultipleOutputs: true,
    isOscillator: false,
    requiresOHLCV: false,
    requiresVolume: false,
    defaultParams: { stdDevMultiplier: 2 },
    outputKeys: ["upper", "middle", "lower"],
  },
  ATR: {
    type: "ATR",
    name: "Average True Range",
    shortName: "ATR",
    description: "Volatility measure (works best with OHLC)",
    category: "Volatility",
    defaultPeriod: 14,
    hasMultipleOutputs: false,
    isOscillator: false,
    requiresOHLCV: true,
    requiresVolume: false,
  },
  STDDEV: {
    type: "STDDEV",
    name: "Standard Deviation",
    shortName: "StdDev",
    description: "Rolling standard deviation",
    category: "Volatility",
    defaultPeriod: 20,
    hasMultipleOutputs: false,
    isOscillator: false,
    requiresOHLCV: false,
    requiresVolume: false,
  },
  HVOL: {
    type: "HVOL",
    name: "Historical Volatility",
    shortName: "HVol",
    description: "Annualized volatility (assumes 252 trading days)",
    category: "Volatility",
    defaultPeriod: 20,
    hasMultipleOutputs: false,
    isOscillator: false,
    requiresOHLCV: false,
    requiresVolume: false,
  },
  KELT: {
    type: "KELT",
    name: "Keltner Channels",
    shortName: "Kelt",
    description: "ATR-based volatility bands",
    category: "Volatility",
    defaultPeriod: 20,
    hasMultipleOutputs: true,
    isOscillator: false,
    requiresOHLCV: true,
    requiresVolume: false,
    defaultParams: { stdDevMultiplier: 2 },
    outputKeys: ["upper", "middle", "lower"],
  },
  // Trend
  TRIX: {
    type: "TRIX",
    name: "TRIX",
    shortName: "TRIX",
    description: "Triple smoothed momentum",
    category: "Trend",
    defaultPeriod: 15,
    hasMultipleOutputs: false,
    isOscillator: false,
    requiresOHLCV: false,
    requiresVolume: false,
  },
  ADX: {
    type: "ADX",
    name: "Average Directional Index",
    shortName: "ADX",
    description: "Trend strength (works best with OHLC)",
    category: "Trend",
    defaultPeriod: 14,
    hasMultipleOutputs: true,
    isOscillator: false,
    requiresOHLCV: true,
    requiresVolume: false,
    outputKeys: ["primary", "plusDI", "minusDI"],
  },
  PSAR: {
    type: "PSAR",
    name: "Parabolic SAR",
    shortName: "PSAR",
    description: "Trend reversal indicator (works best with OHLC)",
    category: "Trend",
    defaultPeriod: 14,
    hasMultipleOutputs: false,
    isOscillator: false,
    requiresOHLCV: true,
    requiresVolume: false,
  },
  // Statistical
  CORR: {
    type: "CORR",
    name: "Correlation",
    shortName: "Corr",
    description: "Pearson correlation coefficient",
    category: "Statistical",
    defaultPeriod: 20,
    hasMultipleOutputs: false,
    isOscillator: false,
    requiresOHLCV: false,
    requiresVolume: false,
  },
  LINREG: {
    type: "LINREG",
    name: "Linear Regression",
    shortName: "LinReg",
    description: "Rolling linear regression trend line",
    category: "Statistical",
    defaultPeriod: 20,
    hasMultipleOutputs: false,
    isOscillator: false,
    requiresOHLCV: false,
    requiresVolume: false,
  },
  ZSCORE: {
    type: "ZSCORE",
    name: "Z-Score",
    shortName: "Z",
    description: "Standardized deviation from mean",
    category: "Statistical",
    defaultPeriod: 20,
    hasMultipleOutputs: false,
    isOscillator: false,
    requiresOHLCV: false,
    requiresVolume: false,
  },
  DIFF: {
    type: "DIFF",
    name: "Differencing",
    shortName: "Diff",
    description: "First-order price differences",
    category: "Statistical",
    defaultPeriod: 1,
    hasMultipleOutputs: false,
    isOscillator: false,
    requiresOHLCV: false,
    requiresVolume: false,
  },
  CUMRET: {
    type: "CUMRET",
    name: "Cumulative Returns",
    shortName: "CumRet",
    description: "Cumulative percentage returns",
    category: "Statistical",
    defaultPeriod: 1,
    hasMultipleOutputs: false,
    isOscillator: false,
    requiresOHLCV: false,
    requiresVolume: false,
  },
  // Volume
  OBV: {
    type: "OBV",
    name: "On-Balance Volume",
    shortName: "OBV",
    description: "Volume momentum indicator",
    category: "Volume",
    defaultPeriod: 1,
    hasMultipleOutputs: false,
    isOscillator: false,
    requiresOHLCV: false,
    requiresVolume: true,
  },
  VWAP: {
    type: "VWAP",
    name: "Volume Weighted Average Price",
    shortName: "VWAP",
    description: "Average price weighted by volume",
    category: "Volume",
    defaultPeriod: 1,
    hasMultipleOutputs: false,
    isOscillator: false,
    requiresOHLCV: true,
    requiresVolume: true,
  },
  VOLSMA: {
    type: "VOLSMA",
    name: "Volume SMA",
    shortName: "VolSMA",
    description: "Simple moving average of volume",
    category: "Volume",
    defaultPeriod: 20,
    hasMultipleOutputs: false,
    isOscillator: false,
    requiresOHLCV: false,
    requiresVolume: true,
  },
};

/**
 * Get indicators by category
 */
export function getIndicatorsByCategory(
  category: IndicatorCategory
): IndicatorMetadata[] {
  return Object.values(INDICATOR_METADATA).filter(
    (m) => m.category === category
  );
}

/**
 * Get all indicator categories
 */
export function getIndicatorCategories(): IndicatorCategory[] {
  return [
    "Moving Averages",
    "Momentum",
    "Volatility",
    "Trend",
    "Statistical",
    "Volume",
  ];
}

/**
 * Check if indicator is available for data source
 */
export function isIndicatorAvailable(
  type: IndicatorType,
  _dataSource: IndicatorDataSource,
  _hasOHLCV = false,
  hasVolume = false
): boolean {
  const metadata = INDICATOR_METADATA[type];
  if (!metadata) return false;

  // Volume indicators only available with market data
  if (metadata.requiresVolume && !hasVolume) return false;

  // OHLCV indicators work better with market data but have fallbacks
  // so we don't strictly require them

  return true;
}

/**
 * Check if an indicator type is an oscillator
 */
export function isOscillator(type: IndicatorType): boolean {
  return INDICATOR_METADATA[type]?.isOscillator ?? false;
}

/**
 * Check if an indicator produces multiple outputs
 */
export function isMultiOutput(type: IndicatorType): boolean {
  return INDICATOR_METADATA[type]?.hasMultipleOutputs ?? false;
}

/**
 * Get default label for an indicator
 */
export function getIndicatorLabel(config: IndicatorConfig): string {
  if (config.label) return config.label;

  const metadata = INDICATOR_METADATA[config.type];
  if (!metadata) return `${config.type}(${config.period})`;

  // For multi-output indicators, include output key in label
  if (metadata.hasMultipleOutputs && config.outputKey) {
    return `${metadata.shortName}(${config.period}) ${config.outputKey}`;
  }

  return `${metadata.shortName}(${config.period})`;
}

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
