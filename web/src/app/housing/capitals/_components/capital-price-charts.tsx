"use client";

import dynamic from "next/dynamic";

import type { CapitalPriceChartProps } from "./capital-price-chart";

/** Client-only chart boundary; all props crossing it are JSON-serializable. */
export const CapitalPriceChart = dynamic<CapitalPriceChartProps>(
  () =>
    import("./capital-price-chart").then((module) => module.CapitalPriceChart),
  {
    ssr: false,
    loading: () => (
      <div className="h-[320px] w-full animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />
    ),
  },
);
