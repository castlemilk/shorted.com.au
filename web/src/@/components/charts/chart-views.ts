/**
 * Per-view chart configuration shared by the stock page panel
 * (StockChartPanel) and the public /embed/chart widget (StockChartEmbed).
 *
 * Pure — no React — so both surfaces build the exact same series/axes from the
 * same data and cannot drift (the embed used to be short-only while the panel
 * it was copied from showed price too).
 */
import { seriesColor } from "./chart-theme";
import { calculateSMA } from "./indicators";
import type {
  AxisSpec,
  ChartPoint,
  ChartSeriesSpec,
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

export const priceFmt = (v: number) => `$${v.toFixed(2)}`;
export const shortFmt = (v: number) => `${v.toFixed(1)}%`;

/** Minimum price points before the SMA 20 overlay is drawn. */
export const SMA_PERIOD = 20;
export const SMA_COLOR = "#f59e0b";

export interface ChartViewInput {
  stockCode: string;
  short: ChartPoint[];
  price: ChartPoint[];
  volume: ChartPoint[];
  /** Draw the SMA 20 overlay on price (price + combined views only). */
  showMA?: boolean;
}

export interface ChartViewConfig {
  series: ChartSeriesSpec[];
  volume: ChartPoint[] | undefined;
  indicators: SeriesIndicator[];
  leftAxis: AxisSpec;
  rightAxis: AxisSpec | undefined;
}

/**
 * Series, volume, indicators and axes for one view.
 *
 * - short:    short % alone, area, on the LEFT axis; no volume.
 * - price:    price area on the left axis + volume (+ SMA 20).
 * - combined: price area (left, $) + short % line (right, %) + volume (+ SMA 20).
 *
 * A series whose data is empty is left out, so a partial load renders what
 * arrived rather than nothing.
 */
export function buildChartView(
  view: ChartViewId,
  { stockCode, short, price, volume, showMA = false }: ChartViewInput,
): ChartViewConfig {
  const priceSeries: ChartSeriesSpec = {
    id: `${stockCode}:price`,
    label: "Price",
    color: seriesColor("price"),
    axis: "left",
    kind: "area",
    points: price,
  };
  const shortSeries: ChartSeriesSpec = {
    id: `${stockCode}:short`,
    label: "Short %",
    color: seriesColor("short"),
    // right axis in Combined (dual), left axis when shown alone
    axis: view === "short" ? "left" : "right",
    kind: view === "short" ? "area" : "line",
    points: short,
  };

  const maIndicator: SeriesIndicator[] =
    showMA && price.length >= SMA_PERIOD
      ? [
          {
            id: "sma20",
            seriesId: `${stockCode}:price`,
            label: "SMA 20",
            color: SMA_COLOR,
            values: calculateSMA(
              price.map((p) => p.v),
              SMA_PERIOD,
            ),
          },
        ]
      : [];

  if (view === "short") {
    return {
      series: short.length ? [shortSeries] : [],
      volume: undefined,
      indicators: [],
      leftAxis: { side: "left", format: shortFmt },
      rightAxis: undefined,
    };
  }
  if (view === "price") {
    return {
      series: price.length ? [priceSeries] : [],
      volume,
      indicators: maIndicator,
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
    indicators: maIndicator,
    leftAxis: { side: "left", format: priceFmt },
    rightAxis: { side: "right", format: shortFmt },
  };
}
