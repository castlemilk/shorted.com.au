"use client";

import dynamic from "next/dynamic";

// The Strategy tab's levels chart: its first block under the regime banner, so
// above the fold once the banner is compact on a phone (strategy/page.tsx). It
// reads prices through Connect-RPC, so it is client-only. Only the Strategy page
// reaches this module, so its chunk starts as the module runs in the browser,
// which is on that route alone. The placeholder is the island's own height, so
// the panels below it do not move when it hydrates (measured in strategy/page.tsx).
if (typeof window !== "undefined") {
  void import("./strategy-levels-chart");
}

export const StrategyLevelsChart = dynamic(
  () => import("./strategy-levels-chart").then((m) => m.StrategyLevelsChart),
  {
    ssr: false,
    loading: () => (
      <div className="h-[430px] animate-pulse rounded-lg bg-muted/40" />
    ),
  },
);
