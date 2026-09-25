"use client";

// Client-only boundaries for the council page. Charts and the map cannot SSR
// (visx measures the DOM; the map loads topojson in the browser), and every
// prop that crosses here is plain JSON — format keys, codes, numbers.
import dynamic from "next/dynamic";

import type { CouncilSeriesChartProps } from "./council-series-chart";
import type { CouncilHubMapProps } from "./council-hub-map";
import type { CouncilIndexMapProps } from "./council-index-map";

export const CouncilSeriesChart = dynamic<CouncilSeriesChartProps>(
  () => import("./council-series-chart").then((m) => m.CouncilSeriesChart),
  { ssr: false, loading: () => <div className="h-[220px] w-full animate-pulse rounded-lg bg-muted motion-reduce:animate-none" /> },
);

export const CouncilHubMap = dynamic<CouncilHubMapProps>(
  () => import("./council-hub-map").then((m) => m.CouncilHubMap),
  { ssr: false, loading: () => <div className="h-[420px] w-full animate-pulse rounded-xl bg-muted motion-reduce:animate-none" /> },
);

export const CouncilIndexMap = dynamic<CouncilIndexMapProps>(
  () => import("./council-index-map").then((m) => m.CouncilIndexMap),
  { ssr: false, loading: () => <div className="h-[480px] w-full animate-pulse rounded-xl bg-muted motion-reduce:animate-none" /> },
);
