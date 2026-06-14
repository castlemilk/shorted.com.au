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
}

export interface StockChartProps {
  series: ChartSeriesSpec[]; // 1..N
  volume?: ChartPoint[]; // single-path; hidden in compact / on mobile
  indicators?: SeriesIndicator[];
  oscillators?: OscillatorSpec[];
  leftAxis?: AxisSpec;
  rightAxis?: AxisSpec;
  viewMode?: "absolute" | "normalized"; // default "absolute"
  showBrush?: boolean; // default true in "full"
  height?: number; // default 360
  variant?: "full" | "compact"; // compact: no axis labels, no volume, no brush
  decimationTargetPerPx?: number; // default 2
}
