import { useMemo } from "react";
import { scaleTime, scaleLinear, getTicks } from "@visx/scale";
import type { ChartSeriesSpec } from "./types";

export interface ChartScales {
  dateScale: ReturnType<typeof scaleTime<number>>;
  leftScale: ReturnType<typeof scaleLinear<number>>;
  rightScale: ReturnType<typeof scaleLinear<number>>;
  innerW: number;
  innerH: number;
}

/**
 * The domain a value axis is drawn on: the hard domain if the caller gave one,
 * else the extent of the series on that side, padded.
 */
export function valueDomain(
  series: readonly ChartSeriesSpec[],
  side: "left" | "right",
  hard?: [number, number],
): [number, number] {
  if (hard) return hard;
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of series) {
    if (s.axis !== side) continue;
    for (const p of s.points) {
      if (p.v < lo) lo = p.v;
      if (p.v > hi) hi = p.v;
    }
  }
  if (!Number.isFinite(lo)) return [0, 1];
  // 8% of the range either side. A series with no range (one point, or a
  // flat line) would have no padding and be drawn on its midpoint, so it gets
  // 5% of its value instead: a flat 1 is a ±2.5% window on a $40 price, an
  // axis from -$0.95 to $1.05 on a 5c one, and $-1.00 to $1.00 on one of
  // nothing. Only a value of nothing has no 5% to take, and falls back to 1.
  const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.05 || 1;
  return [lo - pad, hi + pad];
}

/** A value scale over `domain`, its ends rounded out to whole ticks. */
const valueScale = (domain: [number, number], range: [number, number]) =>
  scaleLinear<number>({ domain, range, nice: true });

/**
 * The labels a value axis will print, from the data alone: the ticks of the
 * scale the chart builds for that side, through the axis' own format (or, with
 * none, the scale's, as the axis does). It is what the margin beside the plot is
 * sized from, which has to be known before the scales exist, so it builds the
 * same scale from the same domain rather than reading one. The range does not
 * change a tick, so it is not needed.
 */
export function valueAxisLabels(opts: {
  series: readonly ChartSeriesSpec[];
  side: "left" | "right";
  hard?: [number, number];
  format?: (v: number) => string;
  numTicks: number;
}): string[] {
  const { series, side, hard, format, numTicks } = opts;
  const scale = valueScale(valueDomain(series, side, hard), [0, 1]);
  const print = format ?? scale.tickFormat();
  return getTicks(scale, numTicks).map((tick) => print(Number(tick)));
}

/**
 * The tick values a value axis prints, from the data alone: the same scale and the same
 * count as valueAxisLabels, so a caller that formats the ticks (for their decimals) sees
 * the values the axis draws.
 */
export function valueAxisTicks(opts: {
  series: readonly ChartSeriesSpec[];
  side: "left" | "right";
  hard?: [number, number];
  numTicks: number;
}): number[] {
  const { series, side, hard, numTicks } = opts;
  const scale = valueScale(valueDomain(series, side, hard), [0, 1]);
  return getTicks(scale, numTicks).map((tick) => Number(tick));
}

/** Memoized time scale + per-axis value scales over the (decimated) render data. */
export function useChartScales(opts: {
  series: ChartSeriesSpec[];
  width: number;
  height: number;
  margin: { top: number; right: number; bottom: number; left: number };
  leftDomain?: [number, number];
  rightDomain?: [number, number];
}): ChartScales {
  const { series, width, height, margin, leftDomain, rightDomain } = opts;
  const innerW = Math.max(0, width - margin.left - margin.right);
  const innerH = Math.max(0, height - margin.top - margin.bottom);

  return useMemo(() => {
    let tMin = Infinity;
    let tMax = -Infinity;
    for (const s of series) {
      for (const p of s.points) {
        if (p.t < tMin) tMin = p.t;
        if (p.t > tMax) tMax = p.t;
      }
    }
    if (!Number.isFinite(tMin)) {
      tMin = 0;
      tMax = 1;
    }
    const dateScale = scaleTime<number>({
      domain: [new Date(tMin), new Date(tMax)],
      range: [0, innerW],
    });

    const leftScale = valueScale(valueDomain(series, "left", leftDomain), [innerH, 0]);
    const rightScale = valueScale(valueDomain(series, "right", rightDomain), [innerH, 0]);
    return { dateScale, leftScale, rightScale, innerW, innerH };
  }, [series, innerW, innerH, leftDomain, rightDomain]);
}
