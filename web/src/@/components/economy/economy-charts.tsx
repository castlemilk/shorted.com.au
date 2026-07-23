"use client";

import dynamic from "next/dynamic";

/**
 * Client-only entry point for the economy charts — the dynamic(ssr:false)
 * wrapper keeps connect-web out of SSR (same pattern as housing-charts.tsx).
 */
export const EconomySeriesChart = dynamic(
  () => import("./economy-series-chart").then((m) => m.EconomySeriesChart),
  {
    ssr: false,
    loading: () => (
      <div className="h-[280px] w-full animate-pulse rounded bg-muted" />
    ),
  },
);

export const EconomyComparisonChart = dynamic(
  () =>
    import("./economy-comparison-chart").then(
      (module) => module.EconomyComparisonChart,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="h-[220px] w-full animate-pulse rounded bg-muted" />
    ),
  },
);

export const EconomySeriesChartView = dynamic(
  () =>
    import("./economy-series-chart-view").then(
      (module) => module.EconomySeriesChartView,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="h-[240px] w-full animate-pulse rounded bg-muted" />
    ),
  },
);
