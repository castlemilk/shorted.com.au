"use client";

import dynamic from "next/dynamic";

// TopoJSON fetching and d3 projection stay out of the state page's RSC graph.
export const StateBannerMap = dynamic(
  () => import("./state-banner-map").then((module) => module.StateBannerMap),
  {
    ssr: false,
    loading: () => (
      <div
        aria-hidden="true"
        className="h-full w-full animate-pulse bg-muted/30"
      />
    ),
  },
);
