"use client";

import dynamic from "next/dynamic";

// ssr:false is load-bearing twice over:
//
//  1. the card fetches over connect-web, and anything importing
//     @connectrpc/connect crashes during SSR (see stock-tabs.tsx)
//  2. it keeps politicians_pb out of /shorts/[stockCode]'s First Load JS. That
//     route's bundle budget is 330kB, and an async chunk is excluded from the
//     Next build table that scripts/bundle-budget.mjs parses.
export const PoliticianInterestsCard = dynamic<{ stockCode: string }>(
  () => import("./politician-interests-card").then((m) => m.PoliticianInterestsCard),
  { ssr: false },
);
