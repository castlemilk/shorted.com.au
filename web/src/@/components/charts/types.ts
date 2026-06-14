import type { IndicatorResult } from "@/lib/technical-indicators";

/** A single chart datum: epoch milliseconds + value. */
export type ChartPoint = { t: number; v: number };

/**
 * One renderable series. `points` are raw (pre-decimation), ascending by `t`.
 * The core decimates them and subsamples any aligned indicator arrays by the
 * same kept indices.
 */
export interface ChartSeriesSpec {
  id: string; // e.g. "PLS:short" / "PLS:price"
  label: string; // tooltip/legend label
  color: string; // resolved hex/hsl (from chart-theme)
  axis: "left" | "right"; // dual-axis assignment
  kind: "line" | "area";
  points: ChartPoint[];
  /** Optional per-point overlay values, length === points.length (subsampled with the series). */
  indicatorValues?: (number | null)[];
}

export interface AxisSpec {
  side: "left" | "right";
  label?: string;
  format?: (v: number) => string; // tick + tooltip formatter
  domain?: [number, number]; // optional hard domain
}

export interface StockChartProps {
  series: ChartSeriesSpec[]; // 1..N
  volume?: ChartPoint[]; // single-path; hidden in compact / on mobile
  /** Overlay indicators (drawn on a series' axis), values aligned to that series' raw points. */
  indicators?: IndicatorResult[];
  /** Oscillator indicators (own sub-panel). */
  oscillators?: IndicatorResult[];
  leftAxis?: AxisSpec;
  rightAxis?: AxisSpec;
  viewMode?: "absolute" | "normalized"; // default "absolute"
  showBrush?: boolean; // default true in "full"
  height?: number; // default 360
  variant?: "full" | "compact"; // compact: no axis labels, no volume, no brush
  decimationTargetPerPx?: number; // default 2
}
