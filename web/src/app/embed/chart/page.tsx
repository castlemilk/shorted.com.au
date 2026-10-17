"use client";

import { Suspense } from "react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { parseEmbedChartParams } from "./params";

const fallback = (
  <div className="h-[100vh] w-full p-2">
    <div className="h-full w-full animate-pulse rounded bg-muted" />
  </div>
);

const StockChartEmbed = dynamic(
  () =>
    import("~/@/components/charts/StockChartEmbed").then(
      (m) => m.StockChartEmbed,
    ),
  { ssr: false, loading: () => fallback },
);

function EmbedChartInner() {
  const { code, view, period } = parseEmbedChartParams(useSearchParams());
  return (
    // The iframe IS the viewport: fill it, and let the chart take what is left.
    <div className="h-[100vh] w-full overflow-auto">
      <StockChartEmbed
        // Remount on a param change so the period state resets with the URL.
        key={`${code}:${view}:${period}`}
        stockCode={code}
        defaultView={view}
        defaultPeriod={period}
      />
    </div>
  );
}

/**
 * Embeddable per-stock chart: short interest (default), share price, or both.
 *
 *   <iframe src="https://shorted.com.au/embed/chart?code=BHP" />
 *   <iframe src="https://shorted.com.au/embed/chart?code=BHP&view=combined&period=6m" />
 *
 * Snippets are built by ~/@/lib/embed/snippet; params are parsed by ./params.
 */
export default function EmbedChart() {
  return (
    <Suspense fallback={fallback}>
      <EmbedChartInner />
    </Suspense>
  );
}
