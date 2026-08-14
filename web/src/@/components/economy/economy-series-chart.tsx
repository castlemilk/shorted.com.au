"use client";

import { useQuery } from "@tanstack/react-query";
import { getEconomicSeriesClient } from "~/app/actions/client/getEconomyClient";
import { ArticleSeriesChart } from "@/components/news/mdx/article-series-chart";
import {
  ECONOMY_SERIES_FORMATTERS,
  type EconomySeriesDisplayFormat,
} from "@/lib/economy/map-metrics";

/**
 * Fetches a single economic series client-side and renders it as an amber
 * area chart. Loaded via economy-charts.tsx (dynamic, ssr:false) because it
 * pulls in connect-web. Same pattern as housing-series-chart.tsx.
 */
export function EconomySeriesChart({
  seriesKey,
  ariaLabel,
  format = "percent",
  height = 280,
}: {
  seriesKey: string;
  ariaLabel: string;
  format?: EconomySeriesDisplayFormat;
  height?: number;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ["economy-series", seriesKey],
    queryFn: () => getEconomicSeriesClient([seriesKey]),
    staleTime: 60 * 60 * 1000,
  });

  if (isLoading) {
    return <div className="w-full animate-pulse rounded bg-muted" style={{ height }} />;
  }

  const points = (data?.series[0]?.observations ?? [])
    .map((obs) => ({
      date: new Date(Number(obs.period?.seconds ?? 0n) * 1000),
      value: obs.value,
    }))
    .filter((p) => !Number.isNaN(p.date.getTime()));

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
      formatValue={ECONOMY_SERIES_FORMATTERS[format]}
      height={height}
      gradientId={`economy-${seriesKey.replace(/[^a-z0-9]/gi, "-")}`}
    />
  );
}
