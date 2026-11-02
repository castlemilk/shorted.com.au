/**
 * Pure indicator arithmetic for the stock charts. No React, no DOM, no
 * dependencies. The inputs are finite numbers (the adapters drop the rest), and
 * every output has its input's length, null until there is enough history.
 *
 * Not the legacy time-series-analysis.ts: its macd() seeds the signal line from
 * NaN, so the signal is NaN everywhere.
 */
import type { ChartPoint } from "./types";

export const DAY_MS = 86_400_000;

export type Series = (number | null)[];

const nulls = (n: number): Series => new Array<number | null>(n).fill(null);

/** Simple moving average over `n` values. */
export function sma(values: readonly number[], n: number): Series {
  const out = nulls(values.length);
  if (n < 1) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= n) sum -= values[i - n]!;
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

/** Linearly weighted moving average: the newest value weighs `n`, the oldest 1. */
export function wma(values: readonly number[], n: number): Series {
  const out = nulls(values.length);
  if (n < 1) return out;
  const weights = (n * (n + 1)) / 2;
  for (let i = n - 1; i < values.length; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += values[i - j]! * (n - j);
    out[i] = s / weights;
  }
  return out;
}

/** Exponential moving average, seeded with the simple average of the first `n` values. */
export function ema(values: readonly number[], n: number): Series {
  const out = nulls(values.length);
  if (n < 1 || values.length < n) return out;
  const k = 2 / (n + 1);
  let prev = 0;
  for (let i = 0; i < n; i++) prev += values[i]!;
  prev /= n;
  out[n - 1] = prev;
  for (let i = n; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export interface Bands {
  middle: Series;
  upper: Series;
  lower: Series;
}

/**
 * Bollinger bands: a simple average of `n` with bands `k` population standard
 * deviations either side.
 */
export function bollinger(values: readonly number[], n: number, k: number): Bands {
  const middle = sma(values, n);
  const upper = nulls(values.length);
  const lower = nulls(values.length);
  if (n < 1) return { middle, upper, lower };
  for (let i = n - 1; i < values.length; i++) {
    const m = middle[i]!;
    let sq = 0;
    for (let j = 0; j < n; j++) sq += (values[i - j]! - m) ** 2;
    const sd = Math.sqrt(sq / n);
    upper[i] = m + k * sd;
    lower[i] = m - k * sd;
  }
  return { middle, upper, lower };
}

function rsiValue(gain: number, loss: number): number {
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

/** Relative strength index with Wilder's smoothing. The first value is at point `n`. */
export function rsi(values: readonly number[], n: number): Series {
  const out = nulls(values.length);
  if (n < 1 || values.length <= n) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = values[i]! - values[i - 1]!;
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= n;
  loss /= n;
  out[n] = rsiValue(gain, loss);
  for (let i = n + 1; i < values.length; i++) {
    const d = values[i]! - values[i - 1]!;
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = rsiValue(gain, loss);
  }
  return out;
}

export interface MacdLines {
  macd: Series;
  signal: Series;
  histogram: Series;
}

/** MACD: the fast EMA less the slow one, its `signalN`-period EMA, and the difference. */
export function macd(
  values: readonly number[],
  fast: number,
  slow: number,
  signalN: number,
): MacdLines {
  const f = ema(values, fast);
  const s = ema(values, slow);
  const line = nulls(values.length);
  for (let i = 0; i < values.length; i++) {
    if (f[i] != null && s[i] != null) line[i] = f[i]! - s[i]!;
  }
  const signal = nulls(values.length);
  const histogram = nulls(values.length);
  const start = line.findIndex((v) => v !== null);
  if (start >= 0) {
    // The line is defined from `start` on without a gap (both EMAs are), so the
    // signal is an EMA of that defined run only.
    const sig = ema(line.slice(start) as number[], signalN);
    sig.forEach((v, i) => {
      if (v != null) {
        signal[start + i] = v;
        histogram[start + i] = line[start + i]! - v;
      }
    });
  }
  return { macd: line, signal, histogram };
}

/**
 * Mean of the points in the trailing window (t - windowMs, t]. Null until the
 * input reaches back a whole window, less `slackMs`, so a window that starts a
 * few days short still counts.
 */
export function timeWindowMean(
  points: readonly ChartPoint[],
  windowMs: number,
  slackMs = 7 * DAY_MS,
): Series {
  const out = nulls(points.length);
  if (!points.length || windowMs <= 0) return out;
  const first = points[0]!.t;
  let lo = 0;
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const t = points[i]!.t;
    sum += points[i]!.v;
    while (lo <= i && points[lo]!.t <= t - windowMs) {
      sum -= points[lo]!.v;
      lo++;
    }
    if (first > t - windowMs + slackMs) continue;
    out[i] = sum / (i - lo + 1);
  }
  return out;
}
