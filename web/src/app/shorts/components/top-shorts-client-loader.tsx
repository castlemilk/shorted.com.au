"use client";

import dynamic from "next/dynamic";

// The interactive dashboard of /shorts, the page's main content, so above the
// fold. It imports @connectrpc/connect, so it is client-only. Only the /shorts
// page reaches this module: its chunk starts as the module runs in the browser,
// which is on /shorts alone.
if (typeof window !== "undefined") {
  void import("./top-shorts-client");
}

export const TopShortsClient = dynamic(
  () => import("./top-shorts-client").then((m) => m.TopShortsClient),
  { ssr: false },
);
