/**
 * Pure layout for the chart's indicator legend, and the value domain the
 * indicator lines add to the chart. Kept apart from the product registry
 * (chart-indicators.ts), so StockChart stays independent of it.
 */
import { AXIS_CHAR_PX } from "./axis-margin";
import type { ChartPoint, ChartSeriesSpec, SeriesIndicator } from "./types";

export interface LegendItem {
  label: string;
  color: string;
  dash?: string;
}

export interface LegendLayout {
  /** The items that fit, each with the x it starts at. */
  items: (LegendItem & { x: number })[];
  /** How many items did not fit; shown as "+N". */
  overflow: number;
  /** Where the "+N" starts, after the last item that fits. */
  overflowX: number;
  /** The width of the legend, or 0 when there is nothing to show. */
  width: number;
}

export const LEGEND_SWATCH_PX = 12;
export const LEGEND_HEIGHT_PX = 16;
/**
 * The room the value scales leave above the plot while the legend is drawn: the
 * legend's 4px inset and its height, then 4px before the first value.
 */
export const LEGEND_HEADROOM_PX = 4 + LEGEND_HEIGHT_PX + 4;
export const LEGEND_GAP_PX = 4;
const LEGEND_ITEM_GAP_PX = 10;
const LEGEND_PAD_PX = 4;

/** The width of a label in the chart's axis face, estimated from its characters (as axis-margin does). */
const textWidth = (s: string) => Math.ceil(s.length * AXIS_CHAR_PX);
const itemWidth = (item: LegendItem) =>
  LEGEND_SWATCH_PX + LEGEND_GAP_PX + textWidth(item.label);

/**
 * Lays the items out left to right inside `innerW`, and gives up on the rest,
 * counted as "+N", rather than running past the plot's edge.
 */
export function layoutIndicatorLegend(
  items: readonly LegendItem[],
  innerW: number,
): LegendLayout {
  const placed: (LegendItem & { x: number })[] = [];
  let x = LEGEND_PAD_PX;
  let overflow = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const rest = items.length - i - 1;
    const more = rest > 0 ? LEGEND_ITEM_GAP_PX + textWidth(`+${rest}`) : 0;
    if (x + itemWidth(item) + more > innerW - LEGEND_PAD_PX) {
      overflow = items.length - i;
      break;
    }
    placed.push({ ...item, x });
    x += itemWidth(item) + LEGEND_ITEM_GAP_PX;
  }
  const end =
    overflow > 0
      ? x + textWidth(`+${overflow}`)
      : placed.length > 0
        ? x - LEGEND_ITEM_GAP_PX
        : 0;
  return {
    items: placed,
    overflow,
    overflowX: x,
    width: placed.length > 0 || overflow > 0 ? end + LEGEND_PAD_PX : 0,
  };
}

/**
 * The indicator values as series, for fitting the value axes: one for each value
 * array (the line, the band's middle and edges) that is as long as its target
 * series. The points are the finite values inside `range`, at the target's own
 * times, so the time domain is not widened.
 */
export function indicatorDomainSeries(
  indicators: readonly SeriesIndicator[],
  series: readonly ChartSeriesSpec[],
  range: readonly [number, number] | null,
): ChartSeriesSpec[] {
  const out: ChartSeriesSpec[] = [];
  for (const ind of indicators) {
    const target = series.find((s) => s.id === ind.seriesId);
    if (!target) continue;
    const arrays: [string, (number | null)[] | undefined][] = [
      ["values", ind.values],
      ["middle", ind.middle],
      ["upper", ind.upper],
      ["lower", ind.lower],
    ];
    for (const [key, values] of arrays) {
      if (!values || values.length !== target.points.length) continue;
      const points: ChartPoint[] = [];
      target.points.forEach((p, i) => {
        const v = values[i];
        if (v == null || !Number.isFinite(v)) return;
        if (range && (p.t < range[0] || p.t > range[1])) return;
        points.push({ t: p.t, v });
      });
      if (points.length > 0) {
        out.push({
          id: `${ind.id}:domain:${key}`,
          label: ind.label,
          color: ind.color,
          axis: target.axis,
          kind: "line",
          points,
        });
      }
    }
  }
  return out;
}
