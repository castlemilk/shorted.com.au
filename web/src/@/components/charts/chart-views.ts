/**
 * Per-view chart configuration shared by the stock page panel
 * (StockChartPanel) and the public /embed/chart widget (StockChartEmbed).
 *
 * Pure — no React — so both surfaces build the exact same series/axes from the
 * same data and cannot drift (the embed used to be short-only while the panel
 * it was copied from showed price too).
 */
import { seriesColor } from "./chart-theme";
import {
  buildIndicatorLayers,
  chartSeriesId,
  type ChartIndicatorId,
} from "./chart-indicators";
import type {
  AxisSpec,
  ChartPoint,
  ChartSeriesSpec,
  OscillatorSpec,
  SeriesIndicator,
} from "./types";

export const CHART_VIEWS = [
  { id: "combined", label: "Combined", shortLabel: "Combined" },
  { id: "short", label: "Short Interest", shortLabel: "Short" },
  { id: "price", label: "Price & Volume", shortLabel: "Price" },
] as const;

export type ChartViewId = (typeof CHART_VIEWS)[number]["id"];

export function isChartViewId(v: unknown): v is ChartViewId {
  return typeof v === "string" && CHART_VIEWS.some((view) => view.id === v);
}

export function chartViewLabel(view: ChartViewId): string {
  return CHART_VIEWS.find((v) => v.id === view)?.label ?? view;
}

export const CHART_PERIODS = ["1m", "3m", "6m", "1y", "2y", "max"] as const;

export type ChartPeriod = (typeof CHART_PERIODS)[number];

export function isChartPeriod(p: unknown): p is ChartPeriod {
  return (
    typeof p === "string" && (CHART_PERIODS as readonly string[]).includes(p)
  );
}

/** A period in words, for share copy and social cards: "past 3 months". */
export const CHART_PERIOD_PHRASE: Record<ChartPeriod, string> = {
  "1m": "past month",
  "3m": "past 3 months",
  "6m": "past 6 months",
  "1y": "past year",
  "2y": "past 2 years",
  max: "all available history",
};

export const priceFmt = (v: number) => `$${v.toFixed(2)}`;
/**
 * Short interest to two decimals, as ASIC publishes it and the stock header
 * prints it. The chart's readout, its axes and its hover card all go through
 * this one function, so a figure reads the same in each; at one decimal a stock
 * under 1% short read "0.1%" under a header saying "0.08%", and its axis
 * repeated one label at every tick.
 */
export const shortFmt = (v: number) => `${v.toFixed(2)}%`;

export interface ChartViewInput {
  stockCode: string;
  short: ChartPoint[];
  price: ChartPoint[];
  volume: ChartPoint[];
  /** The indicators to draw, already limited to what the visitor may see (chart-indicators.ts). */
  indicators?: readonly ChartIndicatorId[];
  /** Selected indicators still waiting for their history. A panel among them is drawn empty (chart-indicators.ts). */
  pending?: readonly ChartIndicatorId[];
  /** Earlier history for an indicator's warm-up, by target series (chart-indicators.ts, planWarmup). */
  history?: { price?: readonly ChartPoint[]; short?: readonly ChartPoint[] };
}

export interface ChartViewConfig {
  series: ChartSeriesSpec[];
  volume: ChartPoint[] | undefined;
  indicators: SeriesIndicator[];
  /** The panel under the chart (RSI or MACD), aligned to series[0]. */
  oscillators: OscillatorSpec[];
  leftAxis: AxisSpec;
  rightAxis: AxisSpec | undefined;
}

/**
 * Series, volume, indicators and axes for one view.
 *
 * - short:    short % alone, area, on the LEFT axis; no volume.
 * - price:    price area on the left axis + volume (+ the price indicators).
 * - combined: price area (left, $) + short % line (right, %) + volume (+ the indicators).
 *
 * A series whose data is empty is left out, so a partial load renders what
 * arrived rather than nothing. And the axes follow the data: a Combined view
 * with only one of its two series is that series' own view, with its axis on the
 * left in its own unit. Built for both, it drew a short line under a dollar axis
 * with nothing on it ($0.00 to $1.00), or a price beside an empty percentage
 * axis. The view the caller asked for does not change; only what is drawn.
 */
export function buildChartView(
  view: ChartViewId,
  input: ChartViewInput,
): ChartViewConfig {
  const { stockCode, short, price, volume } = input;
  const shown = resolveChartView(view, { price, short });
  if (shown !== view) return buildChartView(shown, input);
  const priceSeries: ChartSeriesSpec = {
    id: chartSeriesId(stockCode, "price"),
    label: "Price",
    color: seriesColor("price"),
    axis: "left",
    kind: "area",
    points: price,
  };
  const shortSeries: ChartSeriesSpec = {
    id: chartSeriesId(stockCode, "short"),
    label: "Short %",
    color: seriesColor("short"),
    // right axis in Combined (dual), left axis when shown alone
    axis: view === "short" ? "left" : "right",
    kind: view === "short" ? "area" : "line",
    points: short,
    // Short interest is already a percentage, so a change in it is a number of
    // percentage points ("+0.21 pp"), not a percent of a percent.
    measureMode: "absolute",
    measureUnit: "pp",
  };
  // The indicators follow the branch they are drawn on, so a price one is never
  // laid over a short-only chart, nor a short one over a price-only chart.
  const layers = (branch: ChartViewId) =>
    buildIndicatorLayers({
      stockCode,
      view: branch,
      price,
      short,
      ids: input.indicators ?? [],
      pending: input.pending,
      history: input.history,
    });

  if (view === "short") {
    return {
      series: short.length ? [shortSeries] : [],
      volume: undefined,
      ...layers("short"),
      leftAxis: { side: "left", format: shortFmt },
      rightAxis: undefined,
    };
  }
  if (view === "price") {
    return {
      series: price.length ? [priceSeries] : [],
      volume,
      ...layers("price"),
      leftAxis: { side: "left", format: priceFmt },
      rightAxis: undefined,
    };
  }
  const series: ChartSeriesSpec[] = [];
  if (price.length) series.push(priceSeries);
  if (short.length) series.push(shortSeries);
  return {
    series,
    volume,
    ...layers("combined"),
    leftAxis: { side: "left", format: priceFmt },
    rightAxis: { side: "right", format: shortFmt },
  };
}

/**
 * The view a chart is drawn as. A Combined view with one of its two series is that
 * series' own view, with its axis in its own unit (buildChartView falls back the
 * same way). Decided from the lengths alone, so the indicators, their menu and
 * their history can follow it before anything is built.
 */
export function resolveChartView(
  view: ChartViewId,
  data: { price: readonly ChartPoint[]; short: readonly ChartPoint[] },
): ChartViewId {
  if (view !== "combined") return view;
  if (!data.price.length && data.short.length) return "short";
  if (!data.short.length && data.price.length) return "price";
  return view;
}
