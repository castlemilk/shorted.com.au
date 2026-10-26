import { decimate } from "~/@/components/charts/decimate";
import type {
  SerializedTimeSeriesData,
  SerializedTimeSeriesPoint,
} from "./getTopPageData";

/** Values per row sparkline. A 180px line draws nothing more from 60. */
export const SPARKLINE_POINTS = 30;

/**
 * One /top table row: exactly what TopPageClient renders from a series.
 *
 * The page used to hand the island the cached series themselves, up to 60
 * ISO-timestamped points per stock: 394 KB of the 438 KB RSC payload, to draw
 * a latest value, a change and a 180px sparkline per row. The cached
 * TopPageData keeps every point; generateMetadata dates the title from it and
 * the cache-freshness guard reads its timestamps.
 */
export interface TopRow {
  productCode: string;
  name: string;
  latestShortPosition: number;
  /**
   * The latest short position minus the period's first point, in percentage
   * points, and 0 when the series has fewer than two points. Full precision:
   * the Change column formats it and its sign picks the arrow.
   */
  change: number;
  /**
   * The period's short positions in time order, at most SPARKLINE_POINTS,
   * rounded to 2 dp. Decimated with LTTB, which keeps the first and last
   * points, plus the period's high and low.
   */
  sparkline: number[];
}

function pointTime(point: SerializedTimeSeriesPoint): number {
  const ms = point.timestamp ? Date.parse(point.timestamp) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

function sparklineValues(points: readonly SerializedTimeSeriesPoint[]): number[] {
  const ordered = [...points].sort((a, b) => pointTime(a) - pointTime(b));
  const kept =
    ordered.length <= SPARKLINE_POINTS
      ? ordered.map((point) => point.shortPosition)
      : // Two short of the cap: keepExtrema may add the high and the low.
        // Indexed by position, which is how the sparkline plots them.
        decimate(
          ordered.map((point, index) => ({ t: index, v: point.shortPosition })),
          SPARKLINE_POINTS - 2,
          { keepExtrema: true },
        ).points.map((point) => point.v);
  return kept.map((value) => Math.round(value * 100) / 100);
}

/** Project cached series to the rows the /top island renders. */
export function toTopRows(series: readonly SerializedTimeSeriesData[]): TopRow[] {
  return series.map((item) => {
    const points = item.points ?? [];
    return {
      productCode: item.productCode,
      name: item.name,
      latestShortPosition: item.latestShortPosition,
      change:
        points.length >= 2
          ? item.latestShortPosition - (points[0]?.shortPosition ?? 0)
          : 0,
      sparkline: sparklineValues(points),
    };
  });
}
