"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { getHousePriceSeriesClient } from "~/app/actions/client/getHousingClient";
import { HousingMultiLineChart } from "./housing-multi-line-chart";
import {
  toSeriesPoints,
  transformSeries,
  type HousingSeriesFormat,
  type HousingSeriesTransform,
} from "./series-data";

export interface HousingComparisonDefinition {
  measure: string;
  label: string;
}

export type HousingComparisonDefinitions =
  | readonly [HousingComparisonDefinition, HousingComparisonDefinition]
  | readonly [
      HousingComparisonDefinition,
      HousingComparisonDefinition,
      HousingComparisonDefinition,
    ];

export interface HousingComparisonChartProps {
  regionCode: string;
  definitions: HousingComparisonDefinitions;
  ariaLabel: string;
  format: HousingSeriesFormat;
  transform?: HousingSeriesTransform;
  height?: number;
}

/** Fetches two or three like-unit housing series and compares them client-side. */
export function HousingComparisonChart({
  regionCode,
  definitions,
  ariaLabel,
  format,
  transform = "level",
  height = 280,
}: HousingComparisonChartProps) {
  const { data, isLoading } = useQuery({
    queryKey: [
      "housing-series-comparison",
      regionCode,
      definitions.map(({ measure }) => measure),
    ],
    queryFn: () =>
      Promise.all(
        definitions.map(({ measure }) =>
          getHousePriceSeriesClient(regionCode, measure, ""),
        ),
      ),
    staleTime: 60 * 60 * 1000,
  });

  const series = useMemo(
    () =>
      (data ?? []).flatMap((response, index) => {
        const definition = definitions[index];
        if (!response || !definition) return [];

        const points = transformSeries(
          toSeriesPoints(response.points),
          transform,
        ).filter(
          (point) =>
            Number.isFinite(point.date.getTime()) && Number.isFinite(point.value),
        );

        return points.length >= 2
          ? [{ label: definition.label, points }]
          : [];
      }),
    [data, definitions, transform],
  );

  if (isLoading) {
    return (
      <div
        className="w-full animate-pulse rounded bg-muted motion-reduce:animate-none"
        style={{ height }}
        role="status"
        aria-busy="true"
        aria-label={`Loading ${ariaLabel}`}
      />
    );
  }

  if (series.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-sm text-muted-foreground motion-reduce:animate-none"
        style={{ height }}
        role="status"
        aria-busy="false"
      >
        No data available
      </div>
    );
  }

  return (
    <HousingMultiLineChart
      series={series}
      ariaLabel={ariaLabel}
      format={format}
      height={height}
    />
  );
}
