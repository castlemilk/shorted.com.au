"use client";

import dynamic from "next/dynamic";

// The growth and drawdown chart, client-only (design 10.4). Its SVG is large and
// is not needed for the first paint of the numbers, so the chart is a lazy chunk
// of its own and the server renders a sized placeholder of the same height, so
// nothing shifts when it mounts.
export const BacktestChart = dynamic(
  () => import("./backtest-chart").then((m) => m.BacktestChart),
  {
    ssr: false,
    loading: () => <BacktestChartSkeleton />,
  },
);

/** The chart's placeholder: the height the drawn chart takes, so the mount moves nothing. */
export function BacktestChartSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="h-[390px] animate-pulse rounded-lg bg-muted/40"
    />
  );
}
