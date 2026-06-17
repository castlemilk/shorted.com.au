"use client";

import React, { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { StockChart } from "./StockChart";
import { seriesColor } from "./chart-theme";
import { calculateSMA } from "./indicators";
import { computeDivergenceRegions } from "./divergence";
import { useStockChartData } from "./use-stock-chart-data";
import type { ChartSeriesSpec, SeriesIndicator } from "./types";

const PERIODS = ["1m", "3m", "6m", "1y", "2y", "max"] as const;
type Period = (typeof PERIODS)[number];

const priceFmt = (v: number) => `$${v.toFixed(2)}`;
const shortFmt = (v: number) => `${v.toFixed(1)}%`;

function Toggle({
  active,
  onClick,
  color,
  children,
}: {
  active: boolean;
  onClick: () => void;
  color?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
        active
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
      )}
      aria-pressed={active}
    >
      {color && (
        <span
          className="h-2 w-2 rounded-full"
          style={{ background: active ? color : "transparent", border: `1px solid ${color}` }}
        />
      )}
      {children}
    </button>
  );
}

export interface StockPriceShortChartProps {
  stockCode: string;
  defaultPeriod?: Period;
  height?: number;
}

/**
 * Consolidated per-stock chart: price (left axis) + short interest (right axis)
 * with volume, brush/zoom, period selector, series toggles, an optional moving
 * average, and a price↔short correlation badge. Built on the shared StockChart.
 */
export function StockPriceShortChart({
  stockCode,
  defaultPeriod = "1y",
  height = 420,
}: StockPriceShortChartProps) {
  const [period, setPeriod] = useState<Period>(defaultPeriod);
  const [showPrice, setShowPrice] = useState(true);
  const [showShort, setShowShort] = useState(true);
  const [showVolume, setShowVolume] = useState(true);
  const [showMA, setShowMA] = useState(false);
  const [showDivergence, setShowDivergence] = useState(false);

  const { short, price, volume, correlation, anyLoading, isError } =
    useStockChartData(stockCode, period);

  // Shorted-only overlay: shade spans where short interest and price trend the
  // SAME way — shorts building into a rally (bearish) or covering into a slide
  // (bullish). Needs both legs; only computed when toggled on.
  const regions = useMemo(
    () =>
      showDivergence && short.length && price.length
        ? computeDivergenceRegions(price, short)
        : [],
    [showDivergence, short, price],
  );

  const series = useMemo(() => {
    const arr: ChartSeriesSpec[] = [];
    if (showPrice && price.length)
      arr.push({
        id: `${stockCode}:price`,
        label: "Price",
        color: seriesColor("price"),
        axis: "left",
        kind: "area",
        points: price,
      });
    if (showShort && short.length)
      arr.push({
        id: `${stockCode}:short`,
        label: "Short %",
        color: seriesColor("short"),
        axis: "right",
        kind: "line",
        points: short,
        // Short interest is already a percentage — measure as point delta ("pp").
        measureMode: "absolute",
        measureUnit: "pp",
      });
    return arr;
  }, [showPrice, showShort, price, short, stockCode]);

  const indicators = useMemo<SeriesIndicator[]>(() => {
    if (!showMA || !showPrice || price.length < 20) return [];
    return [
      {
        id: "sma20",
        seriesId: `${stockCode}:price`,
        label: "SMA 20",
        color: "#f59e0b",
        values: calculateSMA(
          price.map((p) => p.v),
          20,
        ),
      },
    ];
  }, [showMA, showPrice, price, stockCode]);

  const hasData = series.length > 0;

  return (
    <div className="flex flex-col gap-3">
      {/* Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1">
          <Toggle active={showPrice} onClick={() => setShowPrice((v) => !v)} color={seriesColor("price")}>
            Price
          </Toggle>
          <Toggle active={showShort} onClick={() => setShowShort((v) => !v)} color={seriesColor("short")}>
            Short %
          </Toggle>
          <Toggle active={showVolume} onClick={() => setShowVolume((v) => !v)}>
            Volume
          </Toggle>
          <Toggle active={showMA} onClick={() => setShowMA((v) => !v)} color="#f59e0b">
            SMA 20
          </Toggle>
          <Toggle active={showDivergence} onClick={() => setShowDivergence((v) => !v)}>
            Divergence
          </Toggle>
        </div>
        <div className="flex items-center gap-2">
          {correlation != null && showPrice && showShort && (
            <span
              className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground"
              title="Pearson correlation between price and short interest over the selected period"
            >
              corr {correlation >= 0 ? "+" : ""}
              {correlation.toFixed(2)}
            </span>
          )}
          <div className="flex items-center gap-0.5 rounded-md border p-0.5" role="group" aria-label="Period">
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
        </div>
      </div>

      {/* Divergence legend (only when the overlay is on and found something) */}
      {showDivergence && regions.length > 0 && (
        <div className="-mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span
              className="h-2.5 w-2.5 rounded-sm"
              style={{ background: "#ef444433", border: "1px solid #ef4444" }}
            />
            Shorts building into price strength
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span
              className="h-2.5 w-2.5 rounded-sm"
              style={{ background: "#22c55e33", border: "1px solid #22c55e" }}
            />
            Shorts covering into price weakness
          </span>
        </div>
      )}

      {/* Chart */}
      {isError ? (
        <div
          className="flex items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground"
          style={{ height }}
        >
          Unable to load chart data. Please try again later.
        </div>
      ) : hasData ? (
        <StockChart
          series={series}
          volume={showVolume ? volume : undefined}
          indicators={indicators}
          regions={regions}
          leftAxis={{ side: "left", format: priceFmt }}
          rightAxis={{ side: "right", format: shortFmt }}
          height={height}
        />
      ) : anyLoading ? (
        <div
          className="animate-pulse rounded-lg bg-muted/40"
          style={{ height }}
          aria-label="Loading chart"
        />
      ) : (
        <div
          className="flex items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground"
          style={{ height }}
        >
          No chart data available for {stockCode} in this period.
        </div>
      )}
    </div>
  );
}

export default StockPriceShortChart;
