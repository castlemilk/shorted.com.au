"use client";

import dynamic from "next/dynamic";

// Client-only: it queries dividends through Connect-RPC. The Financials tab puts
// it in the tail of the tab, after the filings, so it is below the fold and has
// no preload.
export const DividendHistory = dynamic(
  () => import("./dividend-history").then((m) => m.DividendHistory),
  { ssr: false },
);
