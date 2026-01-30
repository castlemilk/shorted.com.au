/**
 * High-Performance Time Series Analysis Library
 *
 * This library provides efficient, TypedArray-based implementations of
 * technical indicators and statistical operations for time series analysis.
 *
 * Design principles:
 * - Use Float64Array for all calculations (better precision, vectorizable)
 * - Single-pass algorithms where possible
 * - Minimal allocations during calculations
 * - Support for both shorts and market data analysis
 */

// ============================================================================
// Data Structures
// ============================================================================

/**
 * Efficient typed array wrapper for time series data
 */
export interface TimeSeries {
  values: Float64Array;
  timestamps: Float64Array; // Unix ms
  length: number;
}

/**
 * OHLCV data for market analysis (requires full candle data)
 */
export interface OHLCVSeries {
  open: Float64Array;
  high: Float64Array;
  low: Float64Array;
  close: Float64Array;
  volume: Float64Array;
  timestamps: Float64Array;
  length: number;
}

/**
 * Multi-output result for indicators like Bollinger Bands, MACD
 */
export interface IndicatorOutput {
  primary: Float64Array;
  upper?: Float64Array;
  lower?: Float64Array;
  signal?: Float64Array;
  histogram?: Float64Array;
  middle?: Float64Array;
  plusDI?: Float64Array;
  minusDI?: Float64Array;
  percentK?: Float64Array;
  percentD?: Float64Array;
}

/**
 * Linear regression result
 */
export interface LinearRegressionResult {
  trendLine: Float64Array;
  slope: number;
  intercept: number;
  rSquared: number;
}

/**
 * Rolling statistics result
 */
export interface RollingStats {
  mean: Float64Array;
  min: Float64Array;
  max: Float64Array;
  stdDev: Float64Array;
  variance: Float64Array;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Convert regular number array to Float64Array
 */
export function toFloat64Array(data: number[]): Float64Array {
  return Float64Array.from(data);
}

/**
 * Convert Float64Array to regular array with null for NaN values
 */
export function toNullableArray(data: Float64Array): (number | null)[] {
  return Array.from(data, (v) => (Number.isNaN(v) ? null : v));
}

/**
 * Fill first N elements with NaN (for indicators that need warmup period)
 */
function fillNaN(arr: Float64Array, count: number): void {
  for (let i = 0; i < Math.min(count, arr.length); i++) {
    arr[i] = NaN;
  }
}

// ============================================================================
// Moving Averages (Optimized)
// ============================================================================

/**
 * Simple Moving Average using running sum (O(n) time, O(1) extra space)
 */
export function sma(data: Float64Array, period: number): Float64Array {
  const result = new Float64Array(data.length);
  if (period <= 0 || data.length === 0) {
    result.fill(NaN);
    return result;
  }

  fillNaN(result, period - 1);

  let sum = 0;
  // Initial sum
  for (let i = 0; i < period; i++) {
    sum += data[i] ?? 0;
  }
  result[period - 1] = sum / period;

  // Rolling calculation
  for (let i = period; i < data.length; i++) {
    sum = sum - (data[i - period] ?? 0) + (data[i] ?? 0);
    result[i] = sum / period;
  }

  return result;
}

/**
 * Exponential Moving Average
 */
export function ema(data: Float64Array, period: number): Float64Array {
  const result = new Float64Array(data.length);
  if (period <= 0 || data.length === 0) {
    result.fill(NaN);
    return result;
  }

  const multiplier = 2 / (period + 1);
  fillNaN(result, period - 1);

  // First EMA is SMA
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += data[i] ?? 0;
  }
  result[period - 1] = sum / period;

  // EMA calculation
  for (let i = period; i < data.length; i++) {
    result[i] =
      (data[i] ?? 0) * multiplier + (result[i - 1] ?? 0) * (1 - multiplier);
  }

  return result;
}

/**
 * Double Exponential Moving Average (DEMA)
 * DEMA = 2 * EMA - EMA(EMA)
 */
export function dema(data: Float64Array, period: number): Float64Array {
  const ema1 = ema(data, period);
  const ema2 = ema(ema1, period);
  const result = new Float64Array(data.length);

  for (let i = 0; i < data.length; i++) {
    result[i] = 2 * (ema1[i] ?? 0) - (ema2[i] ?? 0);
  }

  // Need 2*(period-1) warmup
  fillNaN(result, 2 * (period - 1));

  return result;
}

/**
 * Triple Exponential Moving Average (TEMA)
 * TEMA = 3*EMA - 3*EMA(EMA) + EMA(EMA(EMA))
 */
export function tema(data: Float64Array, period: number): Float64Array {
  const ema1 = ema(data, period);
  const ema2 = ema(ema1, period);
  const ema3 = ema(ema2, period);
  const result = new Float64Array(data.length);

  for (let i = 0; i < data.length; i++) {
    result[i] =
      3 * (ema1[i] ?? 0) - 3 * (ema2[i] ?? 0) + (ema3[i] ?? 0);
  }

  // Need 3*(period-1) warmup
  fillNaN(result, 3 * (period - 1));

  return result;
}

/**
 * Weighted Moving Average
 */
export function wma(data: Float64Array, period: number): Float64Array {
  const result = new Float64Array(data.length);
  if (period <= 0 || data.length === 0) {
    result.fill(NaN);
    return result;
  }

  fillNaN(result, period - 1);
  const weightSum = (period * (period + 1)) / 2;

  for (let i = period - 1; i < data.length; i++) {
    let weightedSum = 0;
    for (let j = 0; j < period; j++) {
      const weight = period - j;
      weightedSum += (data[i - j] ?? 0) * weight;
    }
    result[i] = weightedSum / weightSum;
  }

  return result;
}

// ============================================================================
// Momentum Indicators
// ============================================================================

/**
 * Relative Strength Index (RSI)
 * RSI = 100 - (100 / (1 + RS))
 * RS = Average Gain / Average Loss
 */
export function rsi(data: Float64Array, period: number = 14): Float64Array {
  const result = new Float64Array(data.length);
  if (period <= 0 || data.length < period + 1) {
    result.fill(NaN);
    return result;
  }

  fillNaN(result, period);

  // Calculate price changes
  const changes = new Float64Array(data.length);
  changes[0] = 0;
  for (let i = 1; i < data.length; i++) {
    changes[i] = (data[i] ?? 0) - (data[i - 1] ?? 0);
  }

  // Initial average gain/loss (SMA)
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = changes[i] ?? 0;
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;

  // First RSI
  if (avgLoss === 0) {
    result[period] = 100;
  } else {
    result[period] = 100 - 100 / (1 + avgGain / avgLoss);
  }

  // Smoothed RSI using Wilder's smoothing
  for (let i = period + 1; i < data.length; i++) {
    const change = changes[i] ?? 0;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    if (avgLoss === 0) {
      result[i] = 100;
    } else {
      result[i] = 100 - 100 / (1 + avgGain / avgLoss);
    }
  }

  return result;
}

/**
 * Moving Average Convergence Divergence (MACD)
 * MACD Line = EMA(fast) - EMA(slow)
 * Signal Line = EMA(MACD, signal)
 * Histogram = MACD - Signal
 */
export function macd(
  data: Float64Array,
  fastPeriod: number = 12,
  slowPeriod: number = 26,
  signalPeriod: number = 9
): IndicatorOutput {
  const emaFast = ema(data, fastPeriod);
  const emaSlow = ema(data, slowPeriod);

  const macdLine = new Float64Array(data.length);
  for (let i = 0; i < data.length; i++) {
    macdLine[i] = (emaFast[i] ?? 0) - (emaSlow[i] ?? 0);
  }

  const signalLine = ema(macdLine, signalPeriod);

  const histogram = new Float64Array(data.length);
  for (let i = 0; i < data.length; i++) {
    histogram[i] = (macdLine[i] ?? 0) - (signalLine[i] ?? 0);
  }

  // Warmup period: slowPeriod - 1 + signalPeriod - 1
  const warmup = slowPeriod - 1 + signalPeriod - 1;
  fillNaN(macdLine, slowPeriod - 1);
  fillNaN(histogram, warmup);

  return {
    primary: macdLine,
    signal: signalLine,
    histogram,
  };
}

/**
 * Stochastic Oscillator
 * %K = (Close - Lowest Low) / (Highest High - Lowest Low) × 100
 * %D = SMA(%K, dPeriod)
 */
export function stochastic(
  high: Float64Array,
  low: Float64Array,
  close: Float64Array,
  kPeriod: number = 14,
  dPeriod: number = 3
): IndicatorOutput {
  const length = close.length;
  const percentK = new Float64Array(length);
  const percentD = new Float64Array(length);

  fillNaN(percentK, kPeriod - 1);

  for (let i = kPeriod - 1; i < length; i++) {
    let lowestLow = Infinity;
    let highestHigh = -Infinity;

    for (let j = 0; j < kPeriod; j++) {
      const l = low[i - j] ?? 0;
      const h = high[i - j] ?? 0;
      if (l < lowestLow) lowestLow = l;
      if (h > highestHigh) highestHigh = h;
    }

    const range = highestHigh - lowestLow;
    if (range === 0) {
      percentK[i] = 50; // Neutral when no range
    } else {
      percentK[i] = (((close[i] ?? 0) - lowestLow) / range) * 100;
    }
  }

  // %D is SMA of %K
  const percentDResult = sma(percentK, dPeriod);
  percentD.set(percentDResult);

  return {
    primary: percentK,
    percentK,
    percentD,
  };
}

/**
 * Stochastic Oscillator using only close prices (for shorts data)
 */
export function stochasticClose(
  data: Float64Array,
  kPeriod: number = 14,
  dPeriod: number = 3
): IndicatorOutput {
  return stochastic(data, data, data, kPeriod, dPeriod);
}

/**
 * Williams %R
 * %R = (Highest High - Close) / (Highest High - Lowest Low) × -100
 */
export function williamsR(
  high: Float64Array,
  low: Float64Array,
  close: Float64Array,
  period: number = 14
): Float64Array {
  const length = close.length;
  const result = new Float64Array(length);

  fillNaN(result, period - 1);

  for (let i = period - 1; i < length; i++) {
    let lowestLow = Infinity;
    let highestHigh = -Infinity;

    for (let j = 0; j < period; j++) {
      const l = low[i - j] ?? 0;
      const h = high[i - j] ?? 0;
      if (l < lowestLow) lowestLow = l;
      if (h > highestHigh) highestHigh = h;
    }

    const range = highestHigh - lowestLow;
    if (range === 0) {
      result[i] = -50; // Neutral when no range
    } else {
      result[i] = ((highestHigh - (close[i] ?? 0)) / range) * -100;
    }
  }

  return result;
}

/**
 * Williams %R using only close prices (for shorts data)
 */
export function williamsRClose(
  data: Float64Array,
  period: number = 14
): Float64Array {
  return williamsR(data, data, data, period);
}

/**
 * Rate of Change (ROC)
 * ROC = ((Close - Close_n) / Close_n) × 100
 */
export function roc(data: Float64Array, period: number = 12): Float64Array {
  const result = new Float64Array(data.length);
  fillNaN(result, period);

  for (let i = period; i < data.length; i++) {
    const prev = data[i - period] ?? 0;
    if (prev === 0) {
      result[i] = 0;
    } else {
      result[i] = (((data[i] ?? 0) - prev) / prev) * 100;
    }
  }

  return result;
}

/**
 * Momentum (simple price difference)
 * MOM = Close - Close_n
 */
export function momentum(
  data: Float64Array,
  period: number = 10
): Float64Array {
  const result = new Float64Array(data.length);
  fillNaN(result, period);

  for (let i = period; i < data.length; i++) {
    result[i] = (data[i] ?? 0) - (data[i - period] ?? 0);
  }

  return result;
}

// ============================================================================
// Volatility Indicators
// ============================================================================

/**
 * Bollinger Bands
 * Middle = SMA(period)
 * Upper = Middle + (K × StdDev)
 * Lower = Middle - (K × StdDev)
 */
export function bollingerBands(
  data: Float64Array,
  period: number = 20,
  stdDevMultiplier: number = 2
): IndicatorOutput {
  const middle = sma(data, period);
  const upper = new Float64Array(data.length);
  const lower = new Float64Array(data.length);

  fillNaN(upper, period - 1);
  fillNaN(lower, period - 1);

  for (let i = period - 1; i < data.length; i++) {
    // Calculate standard deviation
    let sumSq = 0;
    for (let j = 0; j < period; j++) {
      const diff = (data[i - j] ?? 0) - (middle[i] ?? 0);
      sumSq += diff * diff;
    }
    const stdDev = Math.sqrt(sumSq / period);

    upper[i] = (middle[i] ?? 0) + stdDevMultiplier * stdDev;
    lower[i] = (middle[i] ?? 0) - stdDevMultiplier * stdDev;
  }

  return {
    primary: middle,
    middle,
    upper,
    lower,
  };
}

/**
 * True Range (for ATR calculation)
 */
function trueRange(
  high: Float64Array,
  low: Float64Array,
  close: Float64Array
): Float64Array {
  const result = new Float64Array(close.length);

  result[0] = (high[0] ?? 0) - (low[0] ?? 0);

  for (let i = 1; i < close.length; i++) {
    const hl = (high[i] ?? 0) - (low[i] ?? 0);
    const hpc = Math.abs((high[i] ?? 0) - (close[i - 1] ?? 0));
    const lpc = Math.abs((low[i] ?? 0) - (close[i - 1] ?? 0));
    result[i] = Math.max(hl, hpc, lpc);
  }

  return result;
}

/**
 * Average True Range (ATR)
 * Requires OHLC data
 */
export function atr(
  high: Float64Array,
  low: Float64Array,
  close: Float64Array,
  period: number = 14
): Float64Array {
  const tr = trueRange(high, low, close);

  // ATR uses Wilder's smoothing (similar to EMA but different multiplier)
  const result = new Float64Array(close.length);
  fillNaN(result, period - 1);

  // Initial ATR is SMA of TR
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += tr[i] ?? 0;
  }
  result[period - 1] = sum / period;

  // Smoothed ATR
  for (let i = period; i < close.length; i++) {
    result[i] =
      ((result[i - 1] ?? 0) * (period - 1) + (tr[i] ?? 0)) / period;
  }

  return result;
}

/**
 * Standard Deviation (rolling)
 */
export function standardDeviation(
  data: Float64Array,
  period: number = 20
): Float64Array {
  const result = new Float64Array(data.length);
  const mean = sma(data, period);

  fillNaN(result, period - 1);

  for (let i = period - 1; i < data.length; i++) {
    let sumSq = 0;
    for (let j = 0; j < period; j++) {
      const diff = (data[i - j] ?? 0) - (mean[i] ?? 0);
      sumSq += diff * diff;
    }
    result[i] = Math.sqrt(sumSq / period);
  }

  return result;
}

/**
 * Historical Volatility (annualized)
 * HV = StdDev(log returns) × √252
 */
export function historicalVolatility(
  data: Float64Array,
  period: number = 20
): Float64Array {
  const result = new Float64Array(data.length);

  // Calculate log returns
  const logReturns = new Float64Array(data.length);
  logReturns[0] = NaN;
  for (let i = 1; i < data.length; i++) {
    const prev = data[i - 1] ?? 0;
    const curr = data[i] ?? 0;
    if (prev > 0 && curr > 0) {
      logReturns[i] = Math.log(curr / prev);
    } else {
      logReturns[i] = 0;
    }
  }

  // StdDev of log returns
  const stdDev = standardDeviation(logReturns, period);

  // Annualize (assuming daily data, 252 trading days)
  const annualizationFactor = Math.sqrt(252);
  for (let i = 0; i < data.length; i++) {
    result[i] = (stdDev[i] ?? 0) * annualizationFactor * 100; // as percentage
  }

  return result;
}

/**
 * Keltner Channels
 * Middle = EMA(period)
 * Upper = Middle + (K × ATR)
 * Lower = Middle - (K × ATR)
 */
export function keltnerChannels(
  high: Float64Array,
  low: Float64Array,
  close: Float64Array,
  emaPeriod: number = 20,
  atrPeriod: number = 10,
  multiplier: number = 2
): IndicatorOutput {
  const middle = ema(close, emaPeriod);
  const atrValues = atr(high, low, close, atrPeriod);

  const upper = new Float64Array(close.length);
  const lower = new Float64Array(close.length);

  const warmup = Math.max(emaPeriod, atrPeriod) - 1;
  fillNaN(upper, warmup);
  fillNaN(lower, warmup);

  for (let i = warmup; i < close.length; i++) {
    const atrVal = atrValues[i] ?? 0;
    upper[i] = (middle[i] ?? 0) + multiplier * atrVal;
    lower[i] = (middle[i] ?? 0) - multiplier * atrVal;
  }

  return {
    primary: middle,
    middle,
    upper,
    lower,
  };
}

// ============================================================================
// Trend Indicators
// ============================================================================

/**
 * TRIX (Triple Exponential Average Rate of Change)
 * TRIX = ROC(EMA(EMA(EMA(close))))
 */
export function trix(data: Float64Array, period: number = 15): Float64Array {
  const ema1 = ema(data, period);
  const ema2 = ema(ema1, period);
  const ema3 = ema(ema2, period);

  const result = new Float64Array(data.length);
  fillNaN(result, 3 * (period - 1) + 1);

  for (let i = 3 * (period - 1) + 1; i < data.length; i++) {
    const prev = ema3[i - 1] ?? 0;
    if (prev === 0) {
      result[i] = 0;
    } else {
      result[i] = (((ema3[i] ?? 0) - prev) / prev) * 100;
    }
  }

  return result;
}

/**
 * Average Directional Index (ADX)
 * Measures trend strength
 */
export function adx(
  high: Float64Array,
  low: Float64Array,
  close: Float64Array,
  period: number = 14
): IndicatorOutput {
  const length = close.length;
  const plusDM = new Float64Array(length);
  const minusDM = new Float64Array(length);
  const tr = trueRange(high, low, close);

  // Calculate +DM and -DM
  for (let i = 1; i < length; i++) {
    const upMove = (high[i] ?? 0) - (high[i - 1] ?? 0);
    const downMove = (low[i - 1] ?? 0) - (low[i] ?? 0);

    plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
  }

  // Smooth with Wilder's smoothing
  const smoothedTR = new Float64Array(length);
  const smoothedPlusDM = new Float64Array(length);
  const smoothedMinusDM = new Float64Array(length);

  // Initial sums
  let sumTR = 0,
    sumPlusDM = 0,
    sumMinusDM = 0;
  for (let i = 1; i <= period; i++) {
    sumTR += tr[i] ?? 0;
    sumPlusDM += plusDM[i] ?? 0;
    sumMinusDM += minusDM[i] ?? 0;
  }
  smoothedTR[period] = sumTR;
  smoothedPlusDM[period] = sumPlusDM;
  smoothedMinusDM[period] = sumMinusDM;

  // Smoothed values
  for (let i = period + 1; i < length; i++) {
    smoothedTR[i] =
      (smoothedTR[i - 1] ?? 0) - (smoothedTR[i - 1] ?? 0) / period + (tr[i] ?? 0);
    smoothedPlusDM[i] =
      (smoothedPlusDM[i - 1] ?? 0) -
      (smoothedPlusDM[i - 1] ?? 0) / period +
      (plusDM[i] ?? 0);
    smoothedMinusDM[i] =
      (smoothedMinusDM[i - 1] ?? 0) -
      (smoothedMinusDM[i - 1] ?? 0) / period +
      (minusDM[i] ?? 0);
  }

  // Calculate +DI, -DI
  const plusDI = new Float64Array(length);
  const minusDI = new Float64Array(length);
  fillNaN(plusDI, period);
  fillNaN(minusDI, period);

  for (let i = period; i < length; i++) {
    const trVal = smoothedTR[i] ?? 0;
    plusDI[i] = trVal === 0 ? 0 : ((smoothedPlusDM[i] ?? 0) / trVal) * 100;
    minusDI[i] = trVal === 0 ? 0 : ((smoothedMinusDM[i] ?? 0) / trVal) * 100;
  }

  // Calculate DX
  const dx = new Float64Array(length);
  for (let i = period; i < length; i++) {
    const sum = (plusDI[i] ?? 0) + (minusDI[i] ?? 0);
    dx[i] =
      sum === 0
        ? 0
        : (Math.abs((plusDI[i] ?? 0) - (minusDI[i] ?? 0)) / sum) * 100;
  }

  // ADX is EMA of DX
  const adxResult = new Float64Array(length);
  fillNaN(adxResult, 2 * period - 1);

  // First ADX is SMA of DX
  let sumDX = 0;
  for (let i = period; i < 2 * period; i++) {
    sumDX += dx[i] ?? 0;
  }
  adxResult[2 * period - 1] = sumDX / period;

  // Smoothed ADX
  for (let i = 2 * period; i < length; i++) {
    adxResult[i] =
      ((adxResult[i - 1] ?? 0) * (period - 1) + (dx[i] ?? 0)) / period;
  }

  return {
    primary: adxResult,
    plusDI,
    minusDI,
  };
}

/**
 * Parabolic SAR
 * Trend-following indicator with stop-and-reverse points
 */
export function parabolicSAR(
  high: Float64Array,
  low: Float64Array,
  accelerationStart: number = 0.02,
  accelerationMax: number = 0.2,
  accelerationStep: number = 0.02
): Float64Array {
  const length = high.length;
  const result = new Float64Array(length);

  if (length < 2) {
    result.fill(NaN);
    return result;
  }

  let isUptrend = (high[1] ?? 0) > (high[0] ?? 0);
  let af = accelerationStart;
  let ep = isUptrend ? high[0] ?? 0 : low[0] ?? 0;
  let sar = isUptrend ? low[0] ?? 0 : high[0] ?? 0;

  result[0] = sar;

  for (let i = 1; i < length; i++) {
    const prevSar = sar;
    sar = prevSar + af * (ep - prevSar);

    if (isUptrend) {
      // Ensure SAR is below the last two lows
      if (i >= 2) {
        sar = Math.min(sar, low[i - 1] ?? 0, low[i - 2] ?? 0);
      } else {
        sar = Math.min(sar, low[i - 1] ?? 0);
      }

      // Check for reversal
      if ((low[i] ?? 0) < sar) {
        isUptrend = false;
        sar = ep;
        ep = low[i] ?? 0;
        af = accelerationStart;
      } else {
        if ((high[i] ?? 0) > ep) {
          ep = high[i] ?? 0;
          af = Math.min(af + accelerationStep, accelerationMax);
        }
      }
    } else {
      // Downtrend
      // Ensure SAR is above the last two highs
      if (i >= 2) {
        sar = Math.max(sar, high[i - 1] ?? 0, high[i - 2] ?? 0);
      } else {
        sar = Math.max(sar, high[i - 1] ?? 0);
      }

      // Check for reversal
      if ((high[i] ?? 0) > sar) {
        isUptrend = true;
        sar = ep;
        ep = high[i] ?? 0;
        af = accelerationStart;
      } else {
        if ((low[i] ?? 0) < ep) {
          ep = low[i] ?? 0;
          af = Math.min(af + accelerationStep, accelerationMax);
        }
      }
    }

    result[i] = sar;
  }

  return result;
}

// ============================================================================
// Statistical Operations
// ============================================================================

/**
 * Pearson Correlation between two series
 */
export function correlation(
  series1: Float64Array,
  series2: Float64Array,
  period: number = 20
): Float64Array {
  const length = Math.min(series1.length, series2.length);
  const result = new Float64Array(length);
  fillNaN(result, period - 1);

  for (let i = period - 1; i < length; i++) {
    let sumX = 0,
      sumY = 0,
      sumXY = 0,
      sumX2 = 0,
      sumY2 = 0;

    for (let j = 0; j < period; j++) {
      const x = series1[i - j] ?? 0;
      const y = series2[i - j] ?? 0;
      sumX += x;
      sumY += y;
      sumXY += x * y;
      sumX2 += x * x;
      sumY2 += y * y;
    }

    const numerator = period * sumXY - sumX * sumY;
    const denominator = Math.sqrt(
      (period * sumX2 - sumX * sumX) * (period * sumY2 - sumY * sumY)
    );

    result[i] = denominator === 0 ? 0 : numerator / denominator;
  }

  return result;
}

/**
 * Linear Regression
 */
export function linearRegression(
  data: Float64Array
): LinearRegressionResult {
  const n = data.length;
  const trendLine = new Float64Array(n);

  if (n < 2) {
    trendLine.fill(NaN);
    return { trendLine, slope: 0, intercept: 0, rSquared: 0 };
  }

  // Calculate means
  let sumX = 0,
    sumY = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += data[i] ?? 0;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;

  // Calculate slope and intercept
  let numerator = 0,
    denominator = 0;
  for (let i = 0; i < n; i++) {
    const xDiff = i - meanX;
    const yDiff = (data[i] ?? 0) - meanY;
    numerator += xDiff * yDiff;
    denominator += xDiff * xDiff;
  }

  const slope = denominator === 0 ? 0 : numerator / denominator;
  const intercept = meanY - slope * meanX;

  // Generate trend line and calculate R²
  let ssRes = 0,
    ssTot = 0;
  for (let i = 0; i < n; i++) {
    trendLine[i] = intercept + slope * i;
    const residual = (data[i] ?? 0) - trendLine[i];
    ssRes += residual * residual;
    ssTot += ((data[i] ?? 0) - meanY) * ((data[i] ?? 0) - meanY);
  }

  const rSquared = ssTot === 0 ? 0 : 1 - ssRes / ssTot;

  return { trendLine, slope, intercept, rSquared };
}

/**
 * Rolling Linear Regression
 */
export function rollingLinearRegression(
  data: Float64Array,
  period: number = 20
): Float64Array {
  const result = new Float64Array(data.length);
  fillNaN(result, period - 1);

  for (let i = period - 1; i < data.length; i++) {
    // Extract window
    const window = data.subarray(i - period + 1, i + 1);
    const { trendLine } = linearRegression(window);
    result[i] = trendLine[period - 1] ?? 0;
  }

  return result;
}

/**
 * Z-Score Normalization
 */
export function zScore(data: Float64Array, period: number = 20): Float64Array {
  const result = new Float64Array(data.length);
  const mean = sma(data, period);
  const stdDev = standardDeviation(data, period);

  fillNaN(result, period - 1);

  for (let i = period - 1; i < data.length; i++) {
    const std = stdDev[i] ?? 0;
    if (std === 0) {
      result[i] = 0;
    } else {
      result[i] = ((data[i] ?? 0) - (mean[i] ?? 0)) / std;
    }
  }

  return result;
}

/**
 * First-order differencing
 */
export function difference(data: Float64Array, order: number = 1): Float64Array {
  let result = new Float64Array(data);

  for (let o = 0; o < order; o++) {
    const temp = new Float64Array(result.length);
    temp[0] = NaN;
    for (let i = 1; i < result.length; i++) {
      temp[i] = (result[i] ?? 0) - (result[i - 1] ?? 0);
    }
    result = temp;
  }

  fillNaN(result, order);
  return result;
}

/**
 * Cumulative Returns
 */
export function cumulativeReturns(data: Float64Array): Float64Array {
  const result = new Float64Array(data.length);

  if (data.length === 0) return result;

  const firstValue = data[0] ?? 0;
  if (firstValue === 0) {
    result.fill(0);
    return result;
  }

  for (let i = 0; i < data.length; i++) {
    result[i] = (((data[i] ?? 0) - firstValue) / firstValue) * 100;
  }

  return result;
}

/**
 * Log Transform
 */
export function logTransform(data: Float64Array): Float64Array {
  const result = new Float64Array(data.length);

  for (let i = 0; i < data.length; i++) {
    const val = data[i] ?? 0;
    result[i] = val > 0 ? Math.log(val) : NaN;
  }

  return result;
}

/**
 * Rolling Statistics (single pass for efficiency)
 */
export function rollingStats(
  data: Float64Array,
  period: number = 20
): RollingStats {
  const length = data.length;
  const mean = sma(data, period);
  const min = new Float64Array(length);
  const max = new Float64Array(length);
  const variance = new Float64Array(length);
  const stdDev = new Float64Array(length);

  fillNaN(min, period - 1);
  fillNaN(max, period - 1);
  fillNaN(variance, period - 1);
  fillNaN(stdDev, period - 1);

  for (let i = period - 1; i < length; i++) {
    let minVal = Infinity;
    let maxVal = -Infinity;
    let sumSq = 0;

    for (let j = 0; j < period; j++) {
      const val = data[i - j] ?? 0;
      if (val < minVal) minVal = val;
      if (val > maxVal) maxVal = val;
      const diff = val - (mean[i] ?? 0);
      sumSq += diff * diff;
    }

    min[i] = minVal;
    max[i] = maxVal;
    variance[i] = sumSq / period;
    stdDev[i] = Math.sqrt(variance[i] ?? 0);
  }

  return { mean, min, max, stdDev, variance };
}

/**
 * Rolling Percentile
 */
export function rollingPercentile(
  data: Float64Array,
  period: number = 20,
  percentile: number = 50
): Float64Array {
  const result = new Float64Array(data.length);
  fillNaN(result, period - 1);

  const window: number[] = [];

  for (let i = period - 1; i < data.length; i++) {
    window.length = 0;
    for (let j = 0; j < period; j++) {
      window.push(data[i - j] ?? 0);
    }
    window.sort((a, b) => a - b);

    const index = (percentile / 100) * (period - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);

    if (lower === upper) {
      result[i] = window[lower] ?? 0;
    } else {
      const weight = index - lower;
      result[i] =
        (window[lower] ?? 0) * (1 - weight) + (window[upper] ?? 0) * weight;
    }
  }

  return result;
}

// ============================================================================
// Volume Indicators
// ============================================================================

/**
 * On-Balance Volume (OBV)
 */
export function obv(close: Float64Array, volume: Float64Array): Float64Array {
  const result = new Float64Array(close.length);

  if (close.length === 0) return result;

  result[0] = volume[0] ?? 0;

  for (let i = 1; i < close.length; i++) {
    const priceChange = (close[i] ?? 0) - (close[i - 1] ?? 0);
    if (priceChange > 0) {
      result[i] = (result[i - 1] ?? 0) + (volume[i] ?? 0);
    } else if (priceChange < 0) {
      result[i] = (result[i - 1] ?? 0) - (volume[i] ?? 0);
    } else {
      result[i] = result[i - 1] ?? 0;
    }
  }

  return result;
}

/**
 * Volume Weighted Average Price (VWAP)
 * Cumulative (typical price * volume) / cumulative volume
 */
export function vwap(
  high: Float64Array,
  low: Float64Array,
  close: Float64Array,
  volume: Float64Array
): Float64Array {
  const result = new Float64Array(close.length);
  let cumVolume = 0;
  let cumTPV = 0; // typical price * volume

  for (let i = 0; i < close.length; i++) {
    const typicalPrice =
      ((high[i] ?? 0) + (low[i] ?? 0) + (close[i] ?? 0)) / 3;
    cumTPV += typicalPrice * (volume[i] ?? 0);
    cumVolume += volume[i] ?? 0;

    result[i] = cumVolume === 0 ? typicalPrice : cumTPV / cumVolume;
  }

  return result;
}

/**
 * Volume SMA
 */
export function volumeSMA(
  volume: Float64Array,
  period: number = 20
): Float64Array {
  return sma(volume, period);
}

// ============================================================================
// Utility: Calculate any indicator by name
// ============================================================================

export type IndicatorName =
  // Moving Averages
  | "SMA"
  | "EMA"
  | "WMA"
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

export interface CalculationParams {
  period?: number;
  fastPeriod?: number;
  slowPeriod?: number;
  signalPeriod?: number;
  stdDevMultiplier?: number;
  dPeriod?: number;
  // For OHLCV indicators
  high?: Float64Array;
  low?: Float64Array;
  volume?: Float64Array;
  // For correlation
  series2?: Float64Array;
}

/**
 * Calculate indicator by name with parameters
 * Returns IndicatorOutput for multi-output indicators
 */
export function calculateIndicatorByName(
  name: IndicatorName,
  data: Float64Array,
  params: CalculationParams = {}
): IndicatorOutput {
  const period = params.period ?? 14;

  switch (name) {
    // Moving Averages
    case "SMA":
      return { primary: sma(data, period) };
    case "EMA":
      return { primary: ema(data, period) };
    case "WMA":
      return { primary: wma(data, period) };
    case "DEMA":
      return { primary: dema(data, period) };
    case "TEMA":
      return { primary: tema(data, period) };

    // Momentum
    case "RSI":
      return { primary: rsi(data, period) };
    case "MACD":
      return macd(
        data,
        params.fastPeriod ?? 12,
        params.slowPeriod ?? 26,
        params.signalPeriod ?? 9
      );
    case "STOCH":
      if (params.high && params.low) {
        return stochastic(
          params.high,
          params.low,
          data,
          period,
          params.dPeriod ?? 3
        );
      }
      return stochasticClose(data, period, params.dPeriod ?? 3);
    case "WILLR":
      if (params.high && params.low) {
        return { primary: williamsR(params.high, params.low, data, period) };
      }
      return { primary: williamsRClose(data, period) };
    case "ROC":
      return { primary: roc(data, period) };
    case "MOM":
      return { primary: momentum(data, period) };

    // Volatility
    case "BBANDS":
      return bollingerBands(data, period, params.stdDevMultiplier ?? 2);
    case "ATR":
      if (params.high && params.low) {
        return { primary: atr(params.high, params.low, data, period) };
      }
      // Fallback for non-OHLC data (use data as proxy)
      return { primary: atr(data, data, data, period) };
    case "STDDEV":
      return { primary: standardDeviation(data, period) };
    case "HVOL":
      return { primary: historicalVolatility(data, period) };
    case "KELT":
      if (params.high && params.low) {
        return keltnerChannels(
          params.high,
          params.low,
          data,
          period,
          params.period ?? 10,
          params.stdDevMultiplier ?? 2
        );
      }
      // Fallback
      return keltnerChannels(
        data,
        data,
        data,
        period,
        params.period ?? 10,
        params.stdDevMultiplier ?? 2
      );

    // Trend
    case "TRIX":
      return { primary: trix(data, period) };
    case "ADX":
      if (params.high && params.low) {
        return adx(params.high, params.low, data, period);
      }
      // Fallback
      return adx(data, data, data, period);
    case "PSAR":
      if (params.high && params.low) {
        return { primary: parabolicSAR(params.high, params.low) };
      }
      return { primary: parabolicSAR(data, data) };

    // Statistical
    case "CORR":
      if (params.series2) {
        return { primary: correlation(data, params.series2, period) };
      }
      // Return autocorrelation with lag 1 if no second series
      const lagged = new Float64Array(data.length);
      lagged[0] = NaN;
      lagged.set(data.subarray(0, data.length - 1), 1);
      return { primary: correlation(data, lagged, period) };
    case "LINREG":
      return { primary: rollingLinearRegression(data, period) };
    case "ZSCORE":
      return { primary: zScore(data, period) };
    case "DIFF":
      return { primary: difference(data, 1) };
    case "CUMRET":
      return { primary: cumulativeReturns(data) };

    // Volume
    case "OBV":
      if (params.volume) {
        return { primary: obv(data, params.volume) };
      }
      return { primary: new Float64Array(data.length).fill(NaN) };
    case "VWAP":
      if (params.high && params.low && params.volume) {
        return { primary: vwap(params.high, params.low, data, params.volume) };
      }
      return { primary: new Float64Array(data.length).fill(NaN) };
    case "VOLSMA":
      if (params.volume) {
        return { primary: volumeSMA(params.volume, period) };
      }
      return { primary: new Float64Array(data.length).fill(NaN) };

    default:
      return { primary: new Float64Array(data.length).fill(NaN) };
  }
}

/**
 * Check if an indicator is an oscillator (bounded 0-100 or -100-0)
 */
export function isOscillator(name: IndicatorName): boolean {
  return ["RSI", "STOCH", "WILLR"].includes(name);
}

/**
 * Check if an indicator produces multiple outputs
 */
export function isMultiOutput(name: IndicatorName): boolean {
  return ["MACD", "BBANDS", "STOCH", "ADX", "KELT"].includes(name);
}

/**
 * Get the scale range for an indicator
 */
export function getIndicatorRange(
  name: IndicatorName
): { min: number; max: number } | null {
  switch (name) {
    case "RSI":
    case "STOCH":
      return { min: 0, max: 100 };
    case "WILLR":
      return { min: -100, max: 0 };
    default:
      return null; // Unbounded
  }
}

/**
 * Get overbought/oversold levels for oscillators
 */
export function getOverboughtOversoldLevels(
  name: IndicatorName
): { overbought: number; oversold: number } | null {
  switch (name) {
    case "RSI":
      return { overbought: 70, oversold: 30 };
    case "STOCH":
      return { overbought: 80, oversold: 20 };
    case "WILLR":
      return { overbought: -20, oversold: -80 };
    default:
      return null;
  }
}
