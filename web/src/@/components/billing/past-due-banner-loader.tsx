"use client";

import dynamic from "next/dynamic";

// Client-only: it calls the billing actions. The root layout renders it on every
// route, above the fold whenever it shows, so its chunk starts as this module
// runs in the browser (never on the server). Before, the root layout's first-load
// list downloaded it on every route, and this keeps that timing.
if (typeof window !== "undefined") {
  void import("./past-due-banner");
}

export const PastDueBanner = dynamic(
  () => import("./past-due-banner").then((mod) => ({ default: mod.PastDueBanner })),
  { ssr: false },
);
