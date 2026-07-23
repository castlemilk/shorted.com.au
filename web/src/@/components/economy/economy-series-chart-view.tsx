"use client";

import { ArticleSeriesChart } from "@/components/news/mdx/article-series-chart";
import {
  ECONOMY_SERIES_FORMATTERS,
  type EconomySeriesDisplayFormat,
  type Obs,
} from "@/lib/economy/map-metrics";

/** Presentational dynamic boundary for callers that already fetched a series. */
export function EconomySeriesChartView({
  points,
  seriesKey,
  ariaLabel,
  format,
  height = 240,
}: {
  points: Obs[];
  seriesKey: string;
  ariaLabel: string;
  format: EconomySeriesDisplayFormat;
  height?: number;
}) {
  if (points.length < 2) {
    return (
      <div
        className="flex items-center justify-center text-sm text-muted-foreground"
        style={{ height }}
      >
        No data available for this selection
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
