/** A single chart datum: epoch milliseconds + value (+ optional OHLC for price tooltips). */
export type ChartPoint = {
  t: number;
  v: number;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
};

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
  /**
   * How the drag-to-measure tool reports change between two points on this series.
   * "relative" (default): percentage change (vB−vA)/vA, rendered as e.g. "+4.2%".
   * "absolute": raw delta vB−vA, rendered with `measureUnit` — use for a series
   * already expressed in percent (short interest) so the readout is "−1.1pp".
   */
  measureMode?: "relative" | "absolute";
  /** Suffix for the measure readout in "absolute" mode (e.g. "pp"). Default "". */
  measureUnit?: string;
}

/**
 * A shaded time-span drawn UNDER the series (full plot height). Generic on
 * purpose — the caller decides what a region means (e.g. short-vs-price
 * divergence) and the core just paints it by `tone`.
 */
export interface ChartRegion {
  start: number; // epoch ms (inclusive)
  end: number; // epoch ms (inclusive)
  tone: "bearish" | "bullish";
  label?: string;
}

export interface AxisSpec {
  side: "left" | "right";
  label?: string;
  format?: (v: number) => string; // tick + tooltip formatter
  domain?: [number, number]; // optional hard domain
}

/**
 * An overlay indicator drawn on a target series' axis. All value arrays are
 * aligned 1:1 to that series' RAW points; the core subsamples them by the same
 * LTTB indices it uses for the series.
 */
export interface SeriesIndicator {
  id: string;
  seriesId: string; // which series it overlays (axis + decimation alignment)
  label: string;
  color: string;
  values: (number | null)[];
  dash?: string;
  upper?: (number | null)[]; // optional band (e.g. Bollinger)
  middle?: (number | null)[];
  lower?: (number | null)[];
}

/** An oscillator drawn in its own sub-panel; values aligned to the first series' raw points. */
export interface OscillatorSpec {
  id: string;
  label: string;
  color: string;
  values: (number | null)[];
  dash?: string;
  reference?: number[]; // horizontal guide levels (e.g. [30, 50, 70])
  domain?: [number, number]; // default [0, 100]
  /** Additional lines on the same panel (e.g. STOCH %D, ADX +DI/-DI). */
  extraLines?: { values: (number | null)[]; color: string; dash?: string }[];
}

export interface StockChartProps {
  series: ChartSeriesSpec[]; // 1..N
  volume?: ChartPoint[]; // single-path; hidden in compact / on mobile
  indicators?: SeriesIndicator[];
  oscillators?: OscillatorSpec[];
  /** Shaded time-spans drawn under the series (e.g. short-vs-price divergence). */
  regions?: ChartRegion[];
  leftAxis?: AxisSpec;
  rightAxis?: AxisSpec;
  viewMode?: "absolute" | "normalized"; // default "absolute"
  showBrush?: boolean; // default true in "full"
  height?: number; // default 360
  variant?: "full" | "compact"; // compact: no axis labels, no volume, no brush
  decimationTargetPerPx?: number; // default 2
}
