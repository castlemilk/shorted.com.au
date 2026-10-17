"use client";

import { useMemo } from "react";

import { HousingMultiLineChart } from "../housing-multi-line-chart";
import type { HousingSeriesFormat } from "../series-data";

/** One line: period-end dates ('YYYY-MM-DD') and values. Serializable. */
export interface CouncilChartLine {
  label: string;
  points: ReadonlyArray<{ period: string; value: number }>;
}

export interface CouncilSeriesChartProps {
  lines: readonly CouncilChartLine[];
  ariaLabel: string;
  /** A format KEY, never a function: formatters are looked up client-side. */
  format: HousingSeriesFormat;
  height?: number;
}

/** Adapts the server's serializable council series to the Date-based chart. */
export function CouncilSeriesChart({ lines, ariaLabel, format, height = 220 }: CouncilSeriesChartProps) {
  const series = useMemo(
    () =>
      lines.flatMap(({ label, points }) => {
        const pts = points.flatMap(({ period, value }) => {
          const date = new Date(`${period}T00:00:00.000Z`);
          return Number.isFinite(date.getTime()) && Number.isFinite(value) ? [{ date, value }] : [];
        });
        return pts.length > 1 ? [{ label, points: pts }] : [];
      }),
    [lines],
  );
  if (series.length === 0) return null;
  return <HousingMultiLineChart series={series} ariaLabel={ariaLabel} format={format} height={height} />;
}
