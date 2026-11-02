"use client";

import dynamic from "next/dynamic";

// Client-only: the timeline imports @connectrpc/connect and fetches after
// hydration. It is the last block of the News tab, below the fold, so it has no
// preload.
export const EventTimeline = dynamic(
  () => import("./event-timeline").then((m) => m.EventTimeline),
  { ssr: false },
);
