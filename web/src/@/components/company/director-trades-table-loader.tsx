"use client";

import dynamic from "next/dynamic";
import { DirectorTradesSkeleton } from "./director-trades-skeleton";

// The directors table is the company page's fallback: the page draws the trades
// itself, and hands the section to this island only when that read comes back
// empty. It queries through Connect-RPC, so it is client-only. Its placeholder
// holds the card's place while it loads (director-trades-skeleton.tsx). It is
// below the fold, so it has no preload.
export const DirectorTradesTable = dynamic(
  () => import("./director-trades-table").then((m) => m.DirectorTradesTable),
  { ssr: false, loading: () => <DirectorTradesSkeleton /> },
);
