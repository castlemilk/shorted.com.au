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
    loading: () => <div className="h-[280px] w-full animate-pulse rounded bg-muted" />,
  },
);
