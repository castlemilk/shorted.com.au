"use client";

import { useQuery } from "@tanstack/react-query";
import { getHousePriceSeriesClient } from "~/app/actions/client/getHousingClient";
import { ArticleSeriesChart } from "@/components/news/mdx/article-series-chart";
import {
  formatHousingValue,
  toSeriesPoints,
  transformSeries,
  type HousingSeriesFormat,
  type HousingSeriesTransform,
} from "./series-data";

/**
 * Fetches a single house-price series client-side and renders it as an amber
 * area chart. Loaded via housing-charts.tsx (dynamic, ssr:false) because it
 * pulls in connect-web.
 */
export function HousingSeriesChart({
  regionCode,
  measure,
  dwellingType = "",
  ariaLabel,
  format = "aud",
  transform = "level",
  height = 280,
}: {
  regionCode: string;
  measure: string;
  dwellingType?: string;
  ariaLabel: string;
  format?: HousingSeriesFormat;
  transform?: HousingSeriesTransform;
  height?: number;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ["housing-series", regionCode, measure, dwellingType],
    queryFn: () => getHousePriceSeriesClient(regionCode, measure, dwellingType),
    staleTime: 60 * 60 * 1000,
  });

  if (isLoading) {
    return <div className="w-full animate-pulse rounded bg-muted" style={{ height }} />;
  }

  const points = transformSeries(toSeriesPoints(data?.points ?? []), transform);

  if (points.length < 2) {
    return (
      <div
        className="flex items-center justify-center text-sm text-muted-foreground"
        style={{ height }}
      >
        No data available
      </div>
    );
  }

  return (
    <ArticleSeriesChart
      points={points}
      ariaLabel={ariaLabel}
      formatValue={(value) => formatHousingValue(value, format)}
      height={height}
      gradientId={`housing-${regionCode}-${measure}`}
    />
  );
}
