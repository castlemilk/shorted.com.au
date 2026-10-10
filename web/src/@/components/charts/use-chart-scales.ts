import { useMemo } from "react";
import { scaleTime, scaleLinear } from "@visx/scale";
import type { ChartSeriesSpec } from "./types";

export interface ChartScales {
  dateScale: ReturnType<typeof scaleTime<number>>;
  leftScale: ReturnType<typeof scaleLinear<number>>;
  rightScale: ReturnType<typeof scaleLinear<number>>;
  innerW: number;
  innerH: number;
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

    const axisDomain = (
      side: "left" | "right",
      hard?: [number, number],
    ): [number, number] => {
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
    };

    const leftScale = scaleLinear<number>({
      domain: axisDomain("left", leftDomain),
      range: [innerH, 0],
      nice: true,
    });
    const rightScale = scaleLinear<number>({
      domain: axisDomain("right", rightDomain),
      range: [innerH, 0],
      nice: true,
    });
    return { dateScale, leftScale, rightScale, innerW, innerH };
  }, [series, innerW, innerH, leftDomain, rightDomain]);
}
