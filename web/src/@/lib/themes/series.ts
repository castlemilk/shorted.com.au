// Theme short-interest aggregation.
//
// One theme = a hand-curated basket of 8-15 ASX codes. The chart on
// /themes/[slug] draws the basket's AVERAGE short interest through time with
// the min-max envelope of its constituents shaded behind it.
//
// The weekly bucketing, carry-forward and dispersion maths are NOT reimplemented
// here — they are the same problem /industry-intelligence already solved
// (decimated upstream series, step-function short interest, constituents that
// start and stop at different dates), so this delegates to
// buildIndustryCrowdingSeries and only re-shapes its output. Keep it that way:
// two aggregators that disagree would make the theme chart and the industry
// crowding chart tell different stories about the same stocks.

import {
  buildIndustryCrowdingSeries,
  type CrowdingPoint,
} from "~/@/lib/industry-intelligence";
import { timestampToMs } from "~/@/lib/cache-freshness";

/** One weekly bucket of a theme's short interest. Serializable by design. */
export interface ThemeSeriesPoint {
  /** ISO date of the weekly bucket (Monday). */
  date: string;
  /** Mean short interest across the constituents reporting that week (%). */
  avg: number;
  /** Lowest constituent that week (%). */
  min: number;
  /** Highest constituent that week (%). */
  max: number;
  /** How many constituents contributed to the bucket. */
  count: number;
}

export interface ThemeConstituentSeries {
  code: string;
  points: { date: string; value: number }[];
}

/**
 * Normalise one stock's raw time-series points to `{ date, value }`.
 *
 * `timestamp` reaches us in three shapes depending on the transport and the
 * cache layer it passed through — a protobuf Timestamp with bigint seconds, the
 * same object after Next's data cache coerced bigint to number, and an RFC3339
 * string from the edge-read JSON path. timestampToMs handles all three; points
 * it cannot date are dropped rather than silently bucketed at the epoch.
 */
export function normalizeConstituentPoints(
  points: readonly { timestamp?: unknown; shortPosition?: number }[] | undefined,
): { date: string; value: number }[] {
  const out: { date: string; value: number }[] = [];
  for (const point of points ?? []) {
    const ms = timestampToMs(point.timestamp);
    if (ms === null) continue;
    const value = Number(point.shortPosition);
    if (!Number.isFinite(value)) continue;
    out.push({ date: new Date(ms).toISOString().slice(0, 10), value });
  }
  return out;
}

/**
 * Weekly average + min/max envelope across a theme's constituents.
 *
 * Returns `[]` (never null) when there is not enough overlapping history for a
 * meaningful cross-section, so the page can simply skip the chart. A
 * constituent whose series failed to load is absent from `stocks` and therefore
 * absent from every bucket — it never zeroes the average.
 */
export function buildThemeShortSeries(
  stocks: ThemeConstituentSeries[],
  { minConstituents = 3 }: { minConstituents?: number } = {},
): ThemeSeriesPoint[] {
  const usable = stocks.filter((stock) => stock.points.length > 0);
  if (usable.length === 0) return [];
  // A basket with fewer members than the floor would produce no buckets at all;
  // drop the floor to what is actually available rather than an empty chart.
  const floor = Math.max(1, Math.min(minConstituents, usable.length));
  const series = buildIndustryCrowdingSeries(usable, {
    minConstituents: floor,
  });
  if (!series) return [];
  return series.points.map(toThemePoint);
}

function toThemePoint(point: CrowdingPoint): ThemeSeriesPoint {
  return {
    date: point.date,
    avg: point.avg,
    // min/max are always emitted by buildIndustryCrowdingSeries; the p10/p90
    // fallback keeps this total if an older cached shape is ever replayed.
    min: point.min ?? point.p10,
    max: point.max ?? point.p90,
    count: point.constituents,
  };
}
