"use client";

import dynamic from "next/dynamic";

// Client-only: it queries peers through Connect-RPC. It is the last block of the
// Short interest tab, below the history card and the chart, so it has no preload.
export const PeerComparisonTable = dynamic(
  () => import("./peer-comparison-table").then((m) => m.PeerComparisonTable),
  { ssr: false },
);
