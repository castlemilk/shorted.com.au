"use client";

import dynamic from "next/dynamic";

// Client-only: it queries signals through Connect-RPC. It sits below the chart and
// the history card on the Short interest tab, so it is below the fold and has no
// preload.
export const StockSignals = dynamic(
  () => import("./stock-signals").then((m) => m.StockSignals),
  { ssr: false },
);
