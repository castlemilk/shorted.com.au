"use client";

/**
 * The three charts, loaded after the page: next/dynamic with ssr off, which
 * Next 15 allows only in a client module like this one. d3-hierarchy and
 * d3-sankey travel in these chunks and never in the page's first load
 * (scripts/bundle-budget.mjs). The server renders the placeholder, and the
 * tables under each chart carry every figure until the chart arrives.
 */

import dynamic from "next/dynamic";

function ChartPlaceholder({ height }: { height: number }) {
  return (
    <div
      className="grid w-full place-items-center rounded-md border border-border/60 text-xs text-muted-foreground"
      style={{ height }}
    >
      Drawing the chart…
    </div>
  );
}

export const MarketMapLazy = dynamic(() => import("./market-map").then((m) => m.MarketMap), {
  ssr: false,
  loading: () => <ChartPlaceholder height={420} />,
});

export const MoneyFlowLazy = dynamic(() => import("./money-flow").then((m) => m.MoneyFlow), {
  ssr: false,
  loading: () => <ChartPlaceholder height={320} />,
});

export const PositionHeatmapLazy = dynamic(() => import("./position-heatmap").then((m) => m.PositionHeatmap), {
  ssr: false,
  loading: () => <ChartPlaceholder height={260} />,
});
