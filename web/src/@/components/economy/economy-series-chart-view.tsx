"use client";

import { ArticleSeriesChart } from "@/components/news/mdx/article-series-chart";
import {
  ECONOMY_SERIES_FORMATTERS,
  type EconomySeriesDisplayFormat,
} from "@/lib/economy/map-metrics";

export interface EconomySeriesChartPoint {
  /** Server callers pass ISO strings; existing client-only callers may use Date. */
  date: string | Date;
  value: number;
}

/** Presentational dynamic boundary for callers that already fetched a series. */
export function EconomySeriesChartView({
  points,
  seriesKey,
  ariaLabel,
  format,
  height = 240,
}: {
  points: EconomySeriesChartPoint[];
  seriesKey: string;
  ariaLabel: string;
  format: EconomySeriesDisplayFormat;
  height?: number;
}) {
  // Hydrate dates only after entering this client-only module. Topic pages can
  // therefore pass plain JSON through the RSC boundary without weakening the
  // Date-based chart contract used by ArticleSeriesChart.
  const hydratedPoints = points
    .map((point) => ({
      date:
        point.date instanceof Date
          ? point.date
          : new Date(
              /^\d{4}-\d{2}-\d{2}$/.test(point.date)
                ? `${point.date}T00:00:00.000Z`
                : point.date,
            ),
      value: point.value,
    }))
    .filter((point) => !Number.isNaN(point.date.getTime()));

  if (hydratedPoints.length < 2) {
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
      points={hydratedPoints}
      ariaLabel={ariaLabel}
      formatValue={ECONOMY_SERIES_FORMATTERS[format]}
      height={height}
      gradientId={`economy-${seriesKey.replace(/[^a-z0-9]/gi, "-")}`}
    />
  );
}
