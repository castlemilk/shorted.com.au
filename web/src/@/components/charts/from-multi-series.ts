/**
 * Maps the legacy `MultiSeriesChartData` shape (produced by the dashboard
 * StockChart / TimeSeries widgets) onto the props subset consumed by the
 * shared `StockChart` core. This localizes the widget migration to the render
 * site: the widgets keep building their existing data structure and settings
 * UIs, and only swap the chart they hand it to.
 *
 * The legacy types are redefined locally (rather than imported from
 * multi-series-chart.tsx) so this module survives that component's retirement.
 */
import {
  isOscillator,
  INDICATOR_METADATA,
  type IndicatorConfig,
  type MultiOutputIndicator,
} from "@/lib/technical-indicators";
import type {
  ChartSeriesSpec,
  SeriesIndicator,
  OscillatorSpec,
} from "./types";

/** Legacy series datum. */
export interface MultiSeriesPoint {
  timestamp: Date;
  value: number;
}

/** Legacy series (mirror of multi-series-chart's `ChartSeries`). */
export interface MultiSeriesSeries {
  stockCode: string;
  color: string;
  points: MultiSeriesPoint[];
  seriesType?: "shorts" | "market";
}

/** Legacy indicator overlay (mirror of multi-series-chart's `IndicatorOverlay`). */
export interface MultiSeriesIndicator {
  config: IndicatorConfig;
  values: (number | null)[];
  timestamps?: Date[];
  multiOutput?: MultiOutputIndicator;
}

/** Legacy chart data (mirror of multi-series-chart's `MultiSeriesChartData`). */
export interface MultiSeriesInput {
  series: MultiSeriesSeries[];
  viewMode: "absolute" | "normalized";
  indicators?: MultiSeriesIndicator[];
  hasDualAxis?: boolean;
  showOscillatorPanel?: boolean;
}

export interface FromMultiSeriesResult {
  series: ChartSeriesSpec[];
  indicators: SeriesIndicator[];
  oscillators: OscillatorSpec[];
  viewMode: "absolute" | "normalized";
}

/** Stable id for a legacy series — also the overlay `seriesId` target. */
function seriesId(s: MultiSeriesSeries): string {
  return `${s.stockCode}:${s.seriesType ?? "v"}`;
}

/**
 * Reference levels + value domain for a single-panel oscillator. RSI and
 * Stochastic share the 0-100 momentum band (30/50/70 guides); Williams %R is
 * inverted into the -100..0 band (with mirrored -80/-50/-20 guides).
 */
function oscillatorAxis(type: IndicatorConfig["type"]): {
  reference: number[];
  domain: [number, number];
} {
  if (type === "WILLR") {
    return { reference: [-80, -50, -20], domain: [-100, 0] };
  }
  // RSI, STOCH and any future 0-100 oscillator.
  return { reference: [30, 50, 70], domain: [0, 100] };
}

/**
 * Build a stable, unique id for an overlay/oscillator from its config. Includes
 * the output key so a multi-output indicator's lines never collide.
 */
function indicatorId(config: IndicatorConfig, outputKey?: string): string {
  const base = `${config.stockCode}:${config.dataSource ?? "shorts"}:${config.type}:${config.period}`;
  return outputKey ? `${base}:${outputKey}` : base;
}

function indicatorLabel(config: IndicatorConfig): string {
  const meta = INDICATOR_METADATA[config.type];
  return `${meta?.shortName ?? config.type}(${config.period})`;
}

/**
 * Map a legacy `MultiSeriesChartData` to the StockChart props subset.
 *
 * Series:
 *  - id     = `${stockCode}:${seriesType ?? "v"}`
 *  - label  = stockCode
 *  - axis   = dual-axis ? (market → right, else left) : left
 *  - kind   = "line"
 *  - points = timestamps → epoch ms
 *
 * Indicators are split by `isOscillator(config.type)`:
 *  - overlays → SeriesIndicator on the matching series' axis. The overlay's
 *    `seriesId` MUST equal a built series id or StockChart silently drops it.
 *    We match by the indicator's `dataSource` + bare stockCode, falling back to
 *    the first series sharing the bare stockCode (the legacy `dataSource`-less
 *    contract). Value arrays are aligned 1:1 to that series' raw points — the
 *    widgets compute indicators over the SAME point array used to build the
 *    series, so lengths already match; if they ever diverge StockChart warns
 *    (dev) and skips the overlay.
 *  - oscillators → OscillatorSpec aligned to the FIRST series' raw points,
 *    with reference levels + domain from the oscillator family.
 */
export function fromMultiSeries(data: MultiSeriesInput): FromMultiSeriesResult {
  const hasDualAxis = data.hasDualAxis ?? false;

  const series: ChartSeriesSpec[] = data.series.map((s) => ({
    id: seriesId(s),
    // Market series carry a "PRICE:" prefix on their stockCode; strip it for display.
    label: s.stockCode.replace(/^PRICE:/, ""),
    color: s.color,
    axis:
      hasDualAxis && s.seriesType === "market"
        ? ("right" as const)
        : ("left" as const),
    kind: "line" as const,
    points: s.points.map((p) => ({ t: p.timestamp.getTime(), v: p.value })),
  }));

  // Resolve an overlay/oscillator config to the id of the series it targets.
  // Prefer an exact (stockCode + dataSource) match, then fall back to the first
  // series with the same bare stockCode (dataSource-less legacy overlays).
  const resolveTargetId = (config: IndicatorConfig): string | undefined => {
    const wantMarket = config.dataSource === "market";
    const exact = data.series.find((s) => {
      if (s.stockCode === config.stockCode) {
        return wantMarket ? s.seriesType === "market" : s.seriesType !== "market";
      }
      // Market series carry a "PRICE:" prefix on their stockCode.
      if (wantMarket && s.stockCode === `PRICE:${config.stockCode}`) return true;
      return false;
    });
    if (exact) return seriesId(exact);
    const byCode = data.series.find(
      (s) =>
        s.stockCode === config.stockCode ||
        s.stockCode === `PRICE:${config.stockCode}`,
    );
    return byCode ? seriesId(byCode) : undefined;
  };

  const indicators: SeriesIndicator[] = [];
  const oscillators: OscillatorSpec[] = [];

  for (const ind of data.indicators ?? []) {
    if (ind.config.enabled === false) continue;

    if (isOscillator(ind.config.type)) {
      const { reference, domain } = oscillatorAxis(ind.config.type);
      // Stochastic exposes %K (primary) and %D in the oscillator panel; the
      // core renders a single oscillator line, so prefer %K (primary values).
      oscillators.push({
        id: indicatorId(ind.config),
        label: indicatorLabel(ind.config),
        color: ind.config.color,
        values: ind.values,
        reference,
        domain,
      });
      continue;
    }

    const targetId = resolveTargetId(ind.config);
    if (!targetId) continue;

    indicators.push({
      id: indicatorId(ind.config),
      seriesId: targetId,
      label: indicatorLabel(ind.config),
      color: ind.config.color,
      values: ind.values,
      upper: ind.multiOutput?.upper,
      middle: ind.multiOutput?.middle,
      lower: ind.multiOutput?.lower,
    });
  }

  return { series, indicators, oscillators, viewMode: data.viewMode };
}
