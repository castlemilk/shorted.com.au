"use client";

import dynamic from "next/dynamic";

// ChoroplethMap measures on the client (ParentSize) + pulls d3 → ssr:false,
// same as economy-map-loader.tsx. Keeps the state server page free of the
// measure-on-client chain.
export const StateLocatorMap = dynamic(
  () => import("./state-locator-map").then((m) => m.StateLocatorMap),
  {
    ssr: false,
    loading: () => <div className="h-40 w-full animate-pulse rounded-xl bg-muted" />,
  },
);
