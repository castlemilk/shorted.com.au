"use client";

import { useMemo, useState } from "react";
import { cn } from "~/@/lib/utils";
import { formatDate } from "~/@/lib/fundamentals/format";
import { StockChart } from "~/@/components/charts/StockChart";
import { seriesColor } from "~/@/components/charts/chart-theme";
import { priceFmt, shortFmt } from "~/@/components/charts/chart-views";
import { useStockChartData } from "~/@/components/charts/use-stock-chart-data";
import type {
  ChartSeriesSpec,
  SeriesIndicator,
} from "~/@/components/charts/types";
import type {
  StockPriceFeatures,
  StockStrategyFitRow,
} from "~/app/actions/getStockStrategyFit";
import {
  LEVEL_COLORS,
  defaultStrategyId,
  smaIndicator,
  strategyLevelSet,
} from "./strategy-levels";

// The Strategy tab's chart: the price series with the levels the selected
// strategy's evaluator read, drawn by the shared StockChart. What each
// strategy draws is decided in strategy-levels.ts; this island fetches the
// prices, holds the selection and hands the chart its series.

/** Same period as the layout's chart, so TanStack Query serves this from cache. */
const PERIOD = "1y";
const SMA_COLORS: Record<number, string> = {
  50: LEVEL_COLORS.sma50,
  150: LEVEL_COLORS.sma150,
  200: LEVEL_COLORS.sma200,
};

export interface StrategyLevelsChartProps {
  stockCode: string;
  fits: StockStrategyFitRow[];
  priceFeatures: StockPriceFeatures | null;
  initialStrategyId?: string | null;
}

export function StrategyLevelsChart({
  stockCode,
  fits,
  priceFeatures,
  initialStrategyId,
}: StrategyLevelsChartProps) {
  const [selected, setSelected] = useState<string | null>(
    () => initialStrategyId ?? defaultStrategyId(fits),
  );
  const { price, short, anyLoading, isError } = useStockChartData(
    stockCode,
    PERIOD,
  );

  const fit = fits.find((f) => f.strategyId === selected) ?? null;
  const shortRuleDetail = fit?.rules.find(
    (r) => r.ruleId === "short_interest",
  )?.detail;
  const levelSet = useMemo(
    () => strategyLevelSet(selected ?? "", priceFeatures, { shortRuleDetail }),
    [selected, priceFeatures, shortRuleDetail],
  );

  // The levels are as at the picker's last refresh, while the prices are
  // fetched when the page is viewed, so the newest bar can post-date a level
  // and a level it has crossed would read as current. The date is added here,
  // not to strategyLevelSet().caption, which is the same whatever the date;
  // formatDate gives "" for a date that is not a real day, and then no line.
  const levelsAsAt = formatDate(priceFeatures?.asOf);
  const captionLines = levelsAsAt
    ? [...levelSet.caption, `Levels as at ${levelsAsAt}`]
    : levelSet.caption;

  const series = useMemo<ChartSeriesSpec[]>(() => {
    // Every level and band is a price on the left axis, so nothing is drawn
    // without the price series: the chart would place them against an axis it
    // holds no series for. The short series only ever rides beside it.
    if (!price.length) return [];
    const out: ChartSeriesSpec[] = [
      {
        id: `${stockCode}:price`,
        label: "Price",
        color: seriesColor("price"),
        axis: "left",
        kind: "area",
        points: price,
      },
    ];
    if (levelSet.showShortSeries && short.length) {
      out.push({
        id: `${stockCode}:short`,
        label: "Short %",
        color: seriesColor("short"),
        axis: "right",
        kind: "line",
        points: short,
      });
    }
    return out;
  }, [price, short, levelSet.showShortSeries, stockCode]);

  // A moving-average LINE only for a window the loaded prices fill: never an
  // average over fewer points than its period (the warmup is a gap). The level
  // at the current value is drawn either way.
  const indicators = useMemo<SeriesIndicator[]>(() => {
    const out: SeriesIndicator[] = [];
    for (const period of levelSet.smaPeriods) {
      const values = smaIndicator(price, period);
      if (!values) continue;
      out.push({
        id: `sma${period}`,
        seriesId: `${stockCode}:price`,
        label: `SMA ${period}`,
        color: SMA_COLORS[period] ?? LEVEL_COLORS.range,
        values,
      });
    }
    return out;
  }, [levelSet.smaPeriods, price, stockCode]);

  return (
    <div className="flex flex-col gap-3" data-strategy-chart={selected ?? ""}>
      <div
        className="flex flex-wrap items-center gap-1 rounded-md border p-0.5"
        role="group"
        aria-label="Strategy levels"
      >
        {fits.map((f) => (
          <button
            key={f.strategyId}
            type="button"
            onClick={() => setSelected(f.strategyId)}
            aria-pressed={selected === f.strategyId}
            className={cn(
              "rounded px-2.5 py-1 text-xs font-medium transition-colors",
              selected === f.strategyId
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
            )}
          >
            {f.strategyName}
          </button>
        ))}
      </div>

      {isError ? (
        <div className="flex h-[360px] items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
          Unable to load price data.
        </div>
      ) : series.length ? (
        <StockChart
          series={series}
          indicators={indicators}
          levels={levelSet.levels}
          bands={levelSet.bands}
          markers={levelSet.markers}
          leftAxis={{ side: "left", format: priceFmt }}
          rightAxis={
            levelSet.showShortSeries
              ? { side: "right", format: shortFmt }
              : undefined
          }
          height={360}
          showBrush={false}
        />
      ) : anyLoading ? (
        <div
          role="status"
          aria-label="Loading chart"
          className="h-[360px] animate-pulse rounded-lg bg-muted/40"
        />
      ) : (
        <div className="flex h-[360px] items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
          No price data for {stockCode}.
        </div>
      )}

      {captionLines.length > 0 && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {captionLines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default StrategyLevelsChart;
