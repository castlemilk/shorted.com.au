"use client";

import dynamic from "next/dynamic";

// The levels chart, client-only, for the Strategy tab and the Signals tab's
// evidence panel. It reads prices through Connect-RPC, so it is never rendered on
// the server. Its module starts loading as it runs in the browser, so the chunk
// is ready by the time either page mounts it. The placeholder is the full
// chart's height (the Strategy variant with its selector row). The Signals
// variant has no selector row, so it mounts shorter than the placeholder; that
// shift is accepted, and the panel below it is not fixed-height.
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
