"use client";

import dynamic from "next/dynamic";

// connect-web + measure-on-client → load client-only (same posture as the other
// housing maps).
export const HousingZoomMap = dynamic(
  () => import("./housing-zoom-map").then((m) => m.HousingZoomMap),
  { ssr: false, loading: () => <div className="h-[520px] w-full animate-pulse rounded-xl bg-muted" /> },
);
