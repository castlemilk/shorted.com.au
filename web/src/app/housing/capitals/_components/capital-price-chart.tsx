"use client";

import { useMemo } from "react";

import { HousingMultiLineChart } from "~/@/components/housing/housing-multi-line-chart";
import type { HousingSeriesFormat } from "~/@/components/housing/series-data";

export interface CapitalChartPoint {
  period: string;
  value: number;
}

export interface CapitalChartSeries {
  label: string;
  points: readonly CapitalChartPoint[];
}

export interface CapitalPriceChartProps {
  series: readonly CapitalChartSeries[];
  ariaLabel: string;
  format: HousingSeriesFormat;
  height?: number;
}

/** Adapts serializable route snapshots to the existing Date-based chart. */
export function CapitalPriceChart({
  series,
  ariaLabel,
  format,
  height,
}: CapitalPriceChartProps) {
  const chartSeries = useMemo(
    () =>
      series.flatMap(({ label, points }) => {
        const chartPoints = points.flatMap(({ period, value }) => {
          const date = new Date(`${period}T00:00:00.000Z`);
          return Number.isFinite(date.getTime()) && Number.isFinite(value)
            ? [{ date, value }]
            : [];
        });
        return chartPoints.length > 0 ? [{ label, points: chartPoints }] : [];
      }),
    [series],
  );

  return (
    <HousingMultiLineChart
      series={chartSeries}
      ariaLabel={ariaLabel}
      format={format}
      height={height}
    />
  );
}
