"use client";

import dynamic from "next/dynamic";

// Client-only: it queries the verdict through Connect-RPC. It sits below the chart
// and the history card on the Short interest tab, so it is below the fold and has
// no preload.
export const StockVerdict = dynamic(
  () => import("./stock-verdict").then((m) => m.StockVerdict),
  { ssr: false },
);
