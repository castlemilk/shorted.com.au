"use client";

import dynamic from "next/dynamic";

// Client-only: it queries the stock graph through Connect-RPC. It sits low on the
// Company tab, below the fold, so it has no preload.
export const StockConnections = dynamic(
  () => import("./stock-connections").then((m) => m.StockConnections),
  { ssr: false },
);
