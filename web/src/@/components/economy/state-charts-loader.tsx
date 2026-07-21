"use client";

import dynamic from "next/dynamic";

// The chart grid pulls in the client economy actions (getEconomicSeriesClient /
// listStateCompaniesClient), which transitively import @connectrpc/connect-web.
// Those modules crash Next SSR ("Element type is invalid ... undefined" — see
// CLAUDE.md), so the whole grid is client-only. The old StateDossier dodged
// this by only ever mounting inside the ssr:false explorer; the state PAGE
// renders it directly, so it needs its own ssr:false boundary.
export const StateCharts = dynamic(
  () => import("./state-charts").then((m) => m.StateCharts),
  {
    ssr: false,
    loading: () => (
      <div className="grid gap-4 lg:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-[248px] w-full animate-pulse rounded bg-muted" />
        ))}
      </div>
    ),
  },
);
