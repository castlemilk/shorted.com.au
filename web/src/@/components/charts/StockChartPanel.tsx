"use client";

import React, { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { StockChart } from "./StockChart";
import { seriesColor } from "./chart-theme";
import { calculateSMA } from "./indicators";
import { useStockChartData } from "./use-stock-chart-data";
import { computeDivergenceRegions } from "./divergence";
import type { AxisSpec, ChartSeriesSpec, SeriesIndicator } from "./types";

const PERIODS = ["1m", "3m", "6m", "1y", "2y", "max"] as const;
type Period = (typeof PERIODS)[number];

const VIEWS = [
  { id: "combined", label: "Combined" },
  { id: "short", label: "Short Interest" },
  { id: "price", label: "Price & Volume" },
] as const;
type ViewId = (typeof VIEWS)[number]["id"];

const priceFmt = (v: number) => `$${v.toFixed(2)}`;
const shortFmt = (v: number) => `${v.toFixed(1)}%`;

function SegButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded px-2.5 py-1 text-xs font-medium transition-colors",
        active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
      )}
    >
      {children}
    </button>
  );
}

export interface StockChartPanelProps {
  stockCode: string;
  defaultPeriod?: Period;
  defaultView?: ViewId;
  height?: number;
}

/**
 * Per-stock chart as a tabbed panel: Combined (price + short dual-axis) /
 * Short Interest / Price & Volume. Fetches once via useStockChartData and
 * renders the shared StockChart with the series config for the active view.
 */
export function StockChartPanel({
  stockCode,
  defaultPeriod = "1y",
  defaultView = "combined",
  height = 420,
}: StockChartPanelProps) {
  const [period, setPeriod] = useState<Period>(defaultPeriod);
  const [view, setView] = useState<ViewId>(defaultView);
  const [showMA, setShowMA] = useState(false);
  const [showDivergence, setShowDivergence] = useState(false);

  const { short, price, volume, correlation, anyLoading, isError } =
    useStockChartData(stockCode, period);

  // Shorted-only overlay (combined view): shade spans where short interest and
  // price trend the SAME way — shorts building into a rally (bearish) or
  // covering into a slide (bullish). Only computed when toggled on.
  const regions = useMemo(
    () =>
      showDivergence && view === "combined" && short.length && price.length
        ? computeDivergenceRegions(price, short)
        : [],
    [showDivergence, view, short, price],
  );

  const priceSeries = useMemo<ChartSeriesSpec>(
    () => ({
      id: `${stockCode}:price`,
      label: "Price",
      color: seriesColor("price"),
      axis: "left",
      kind: "area",
      points: price,
    }),
    [price, stockCode],
  );
  const shortSeries = useMemo<ChartSeriesSpec>(
    () => ({
      id: `${stockCode}:short`,
      label: "Short %",
      color: seriesColor("short"),
      // right axis in Combined (dual), left axis when shown alone
      axis: "right",
      kind: view === "short" ? "area" : "line",
      points: short,
    }),
    [short, stockCode, view],
  );

  const maIndicator = useMemo<SeriesIndicator[]>(() => {
    if (!showMA || price.length < 20) return [];
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
  }, [showMA, price, stockCode]);

  // Per-view chart config.
  const { series, vol, indicators, leftAxis, rightAxis } = useMemo(() => {
    if (view === "short") {
      return {
        series: short.length ? [{ ...shortSeries, axis: "left" as const }] : [],
        vol: undefined as undefined | typeof volume,
        indicators: [] as SeriesIndicator[],
        leftAxis: { side: "left", format: shortFmt } as AxisSpec,
        rightAxis: undefined as AxisSpec | undefined,
      };
    }
    if (view === "price") {
      return {
        series: price.length ? [priceSeries] : [],
        vol: volume,
        indicators: maIndicator,
        leftAxis: { side: "left", format: priceFmt } as AxisSpec,
        rightAxis: undefined as AxisSpec | undefined,
      };
    }
    // combined
    const s: ChartSeriesSpec[] = [];
    if (price.length) s.push(priceSeries);
    if (short.length) s.push(shortSeries);
    return {
      series: s,
      vol: volume,
      indicators: maIndicator,
      leftAxis: { side: "left", format: priceFmt } as AxisSpec,
      rightAxis: { side: "right", format: shortFmt } as AxisSpec | undefined,
    };
  }, [view, price, short, priceSeries, shortSeries, volume, maIndicator]);

  const hasData = series.length > 0;
  const showMAToggle = view !== "short";

  return (
    <div className="flex flex-col gap-3">
      {/* Controls: view sub-tabs + period selector */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          className="flex items-center gap-0.5 rounded-md border p-0.5"
          role="tablist"
          aria-label="Chart view"
        >
          {VIEWS.map((v) => (
            <SegButton key={v.id} active={view === v.id} onClick={() => setView(v.id)}>
              {v.label}
            </SegButton>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {view === "combined" && correlation != null && (
            <span
              className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground"
              title="Pearson correlation between price and short interest over the selected period"
            >
              corr {correlation >= 0 ? "+" : ""}
              {correlation.toFixed(2)}
            </span>
          )}
          {showMAToggle && (
            <button
              type="button"
              onClick={() => setShowMA((v) => !v)}
              aria-pressed={showMA}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                showMA
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
              )}
            >
              <span
                className="h-2 w-2 rounded-full"
                style={{ background: showMA ? "#f59e0b" : "transparent", border: "1px solid #f59e0b" }}
              />
              SMA 20
            </button>
          )}
          {view === "combined" && (
            <button
              type="button"
              onClick={() => setShowDivergence((v) => !v)}
              aria-pressed={showDivergence}
              title="Shade spans where short interest and price trend the same way — shorts building into a rally, or covering into a slide"
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                showDivergence
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
              )}
            >
              <span
                className="h-2 w-2 rounded-full"
                style={{
                  background: showDivergence
                    ? "linear-gradient(90deg,#ef4444 50%,#22c55e 50%)"
                    : "transparent",
                  border: "1px solid #94a3b8",
                }}
              />
              Divergence
            </button>
          )}
          <div
            className="flex items-center gap-0.5 rounded-md border p-0.5"
            role="group"
            aria-label="Period"
          >
            {PERIODS.map((p) => (
              <SegButton key={p} active={period === p} onClick={() => setPeriod(p)}>
                <span className="uppercase">{p}</span>
              </SegButton>
            ))}
          </div>
        </div>
      </div>

      {/* Divergence legend (only when on and regions were found) */}
      {showDivergence && view === "combined" && regions.length > 0 && (
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
          volume={vol}
          indicators={indicators}
          regions={regions}
          leftAxis={leftAxis}
          rightAxis={rightAxis}
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

export default StockChartPanel;
