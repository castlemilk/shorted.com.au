"use client";

import dynamic from "next/dynamic";

// connect-web + d3 measure-on-client → client-only (housing-zoom-map-loader pattern).
export const EconomyMapExplorer = dynamic(
  () => import("./economy-map-explorer").then((m) => m.EconomyMapExplorer),
  { ssr: false, loading: () => <div className="h-[560px] w-full animate-pulse rounded-xl bg-muted" /> },
);
