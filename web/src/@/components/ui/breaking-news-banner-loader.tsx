"use client";

import dynamic from "next/dynamic";

// Client-only: it reads the breaking news through Connect-RPC. It sits below the
// dashboard charts on the home page on purpose, so it is not above the fold and
// its chunk starts when it mounts, with no preload.
export const BreakingNewsBanner = dynamic(
  () => import("./breaking-news-banner").then((m) => m.BreakingNewsBanner),
  { ssr: false },
);
