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
      const pad = (hi - lo) * 0.08 || 1;
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
