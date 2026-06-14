"use client";

import React, { useMemo, useState } from "react";
import { useShortTimeSeries } from "@/hooks/use-stock-queries";
import { cn } from "@/lib/utils";
import { StockChart } from "./StockChart";
import { seriesColor } from "./chart-theme";
import { shortSeriesToPoints } from "./adapters";
import type { ChartSeriesSpec } from "./types";

const PERIODS = ["1m", "3m", "6m", "1y", "2y", "max"] as const;
type Period = (typeof PERIODS)[number];

const shortFmt = (v: number) => `${v.toFixed(1)}%`;

export interface ShortChartEmbedProps {
  stockCode: string;
  defaultPeriod?: Period;
  height?: number;
}

/**
 * Lightweight short-position-only chart for the public /embed/chart iframe.
 * Fetches short data and renders the shared StockChart (single series + brush).
 */
export function ShortChartEmbed({
  stockCode,
  defaultPeriod = "1y",
  height = 380,
}: ShortChartEmbedProps) {
  const [period, setPeriod] = useState<Period>(defaultPeriod);
  const { data, isLoading, isError } = useShortTimeSeries(stockCode, period);

  const points = useMemo(() => shortSeriesToPoints(data), [data]);
  const series = useMemo<ChartSeriesSpec[]>(
    () =>
      points.length
        ? [
            {
              id: `${stockCode}:short`,
              label: "Short %",
              color: seriesColor("short"),
              axis: "left",
              kind: "area",
              points,
            },
          ]
        : [],
    [points, stockCode],
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-end gap-0.5 rounded-md border p-0.5" role="group" aria-label="Period">
        {PERIODS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setPeriod(p)}
            aria-pressed={period === p}
            className={cn(
              "rounded px-2 py-0.5 text-xs font-medium uppercase transition-colors",
              period === p
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
            )}
          >
            {p}
          </button>
        ))}
      </div>
      {isError ? (
        <div
          className="flex items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground"
          style={{ height }}
        >
          Unable to load chart data.
        </div>
      ) : series.length ? (
        <StockChart
          series={series}
          leftAxis={{ side: "left", format: shortFmt }}
          height={height}
        />
      ) : isLoading ? (
        <div className="animate-pulse rounded-lg bg-muted/40" style={{ height }} aria-label="Loading chart" />
      ) : (
        <div
          className="flex items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground"
          style={{ height }}
        >
          No short position data available for {stockCode}.
        </div>
      )}
    </div>
  );
}

export default ShortChartEmbed;
