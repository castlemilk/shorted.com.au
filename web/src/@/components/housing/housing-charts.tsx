"use client";

import dynamic from "next/dynamic";

/**
 * Client-only entry point for the housing charts — the dynamic(ssr:false)
 * wrapper keeps connect-web out of SSR (same pattern as the news MDX charts).
 */
export const HousingSeriesChart = dynamic(
  () => import("./housing-series-chart").then((m) => m.HousingSeriesChart),
  {
    ssr: false,
    loading: () => <div className="h-[280px] w-full animate-pulse rounded bg-muted" />,
  },
);
