"use client";

import dynamic from "next/dynamic";

/**
 * Client-only loader for the suburb explorer — its own module (not co-located
 * with the chart loaders) so the dynamic(ssr:false) boundary is clean.
 */
export const SuburbExplorer = dynamic(
  () => import("./suburb-explorer").then((m) => m.SuburbExplorer),
  {
    ssr: false,
    loading: () => <div className="h-[520px] w-full animate-pulse rounded-xl bg-muted" />,
  },
);
