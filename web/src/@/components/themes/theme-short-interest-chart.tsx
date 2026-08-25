"use client";

import {
  IndustryCrowdingChart,
  type CrowdingChartPoint,
} from "~/@/components/industry/charts/industry-crowding-chart";
import type { ThemeSeriesPoint } from "~/@/lib/themes/series";

/**
 * A theme's short interest through time: the basket average as a line, the
 * min-max envelope of its constituents shaded behind it.
 *
 * This is deliberately a THIN adapter over the industry crowding chart rather
 * than a second visx chart. The two surfaces answer the same question about
 * the same underlying series, so they must look and behave identically —
 * duplicating the scales, axes, tooltip and CSS-variable theming here is how
 * that drifts. All statistics are precomputed server-side (see
 * lib/themes/series.ts); every prop below is serializable, because this
 * component is reached from a server page through a dynamic(ssr:false)
 * boundary and a function prop cannot cross it.
 */
export function ThemeShortInterestChart({
  points,
  themeName,
}: {
  points: ThemeSeriesPoint[];
  themeName: string;
}) {
  const mapped: CrowdingChartPoint[] = points.map((point) => ({
    date: point.date,
    value: point.avg,
    bandLo: point.min,
    bandHi: point.max,
    constituents: point.count,
  }));

  return (
    <IndustryCrowdingChart
      points={mapped}
      industryName={themeName}
      mode="level"
      centerLabel="Average"
      bandLabel="Range"
    />
  );
}
