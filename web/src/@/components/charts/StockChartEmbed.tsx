"use client";

import React, { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { useElementSize } from "@/hooks/use-element-size";
import { StockChart } from "./StockChart";
import { seriesColor } from "./chart-theme";
import { useStockChartData } from "./use-stock-chart-data";
import {
  CHART_PERIODS,
  buildChartView,
  chartViewLabel,
  type ChartPeriod,
  type ChartViewId,
} from "./chart-views";

/** Below this the chart is unreadable; the iframe scrolls instead. */
const MIN_CHART_HEIGHT = 160;

const asOfFmt = new Intl.DateTimeFormat("en-AU", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "Australia/Sydney",
});

export interface StockChartEmbedProps {
  stockCode: string;
  defaultView?: ChartViewId;
  defaultPeriod?: ChartPeriod;
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden
        className="inline-block h-0.5 w-3 rounded-full"
        style={{ background: color }}
      />
      {label}
    </span>
  );
}

/**
 * The public /embed/chart widget: the same three views as the stock page's
 * StockChartPanel (built by the shared buildChartView), sized to FILL its
 * container — the embed page gives it a 100vh box, and the chart takes
 * whatever height is left after the header, legend and caption.
 *
 * The view is fixed by the snippet (it is what the publisher chose to embed);
 * only the period is interactive.
 */
export function StockChartEmbed({
  stockCode,
  defaultView = "short",
  defaultPeriod = "1y",
}: StockChartEmbedProps) {
  const [period, setPeriod] = useState<ChartPeriod>(defaultPeriod);
  const view = defaultView;
  const { short, price, volume, anyLoading, isError } = useStockChartData(
    stockCode,
    period,
  );
  const [chartRef, chartBox] = useElementSize<HTMLDivElement>();

  const { series, volume: vol, indicators, leftAxis, rightAxis } = useMemo(
    () => buildChartView(view, { stockCode, short, price, volume }),
    [view, stockCode, short, price, volume],
  );

  const lastShort = short.length ? short[short.length - 1]!.t : null;
  const lastPrice = price.length ? price[price.length - 1]!.t : null;
  const asOf = view === "price" ? lastPrice : (lastShort ?? lastPrice);

  // Combined view with one side missing once loading settles: draw what
  // arrived, and say what didn't.
  const partialNote =
    view === "combined" && !anyLoading && series.length === 1
      ? price.length
        ? "No short position data for this period — showing price only."
        : "No price data for this period — showing short interest only."
      : null;

  const missingNoun =
    view === "short" ? "short" : view === "price" ? "price" : "price or short";

  const chartHeight = Math.max(MIN_CHART_HEIGHT, chartBox.height);

  return (
    <div className="flex h-full min-h-[280px] flex-col gap-2 p-2 sm:p-3">
      {/* Header: code + view, then the period control. Wraps on narrow frames. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <h2 className="flex min-w-0 items-baseline gap-2 text-sm font-semibold">
          <span className="tracking-tight">{stockCode}</span>
          <span className="truncate font-normal text-muted-foreground">
            {chartViewLabel(view)}
          </span>
        </h2>
        <div
          className="flex items-center gap-0.5 rounded-md border p-0.5"
          role="group"
          aria-label="Period"
        >
          {CHART_PERIODS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPeriod(p)}
              aria-pressed={period === p}
              className={cn(
                "inline-flex min-h-8 min-w-8 items-center justify-center rounded px-2 text-xs font-medium uppercase transition-colors",
                // Finger-sized targets where the pointer is a finger.
                "[@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11",
                period === p
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
              )}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      {view === "combined" && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <LegendSwatch color={seriesColor("price")} label="Share price ($, left)" />
          <LegendSwatch color={seriesColor("short")} label="Short interest (%, right)" />
        </div>
      )}

      {/* The chart takes the remaining height; measured, then handed to StockChart. */}
      <div ref={chartRef} className="relative min-h-0 flex-1">
        {isError ? (
          <div className="flex h-full items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
            Unable to load chart data.
          </div>
        ) : series.length ? (
          chartBox.height > 0 && (
            <StockChart
              series={series}
              volume={vol}
              indicators={indicators}
              leftAxis={leftAxis}
              rightAxis={rightAxis}
              height={chartHeight}
              showBrush={false}
            />
          )
        ) : anyLoading ? (
          <div
            className="h-full animate-pulse rounded-lg bg-muted/40"
            aria-label="Loading chart"
          />
        ) : (
          <div className="flex h-full items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
            No {missingNoun} data for {stockCode}.
          </div>
        )}
      </div>

      {/* Caption. Right padding clears the layout's fixed brand link. */}
      <div className="flex min-h-4 flex-wrap items-center gap-x-3 pr-24 text-[11px] text-muted-foreground">
        {asOf != null && series.length > 0 && (
          <span>As of {asOfFmt.format(new Date(asOf))}</span>
        )}
        {partialNote && <span>{partialNote}</span>}
      </div>
    </div>
  );
}

export default StockChartEmbed;
