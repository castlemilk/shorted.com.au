import { bisector } from "@visx/vendor/d3-array";
import type { ChartPoint } from "./types";

const tBisector = bisector<ChartPoint, number>((d) => d.t);

/**
 * Nearest data point to time `t` (binary search; points must be sorted by t).
 *
 * Its own module so `chart-tooltip` (which formats its date with
 * `chart-readout`) and `chart-readout` (which measures with this) do not import
 * each other.
 */
export function nearest(points: ChartPoint[], t: number): ChartPoint | null {
  if (!points.length) return null;
  const i = tBisector.left(points, t, 1);
  const a = points[i - 1];
  const b = points[i];
  if (!a) return b ?? null;
  if (!b) return a;
  return t - a.t < b.t - t ? a : b;
}
