"use client";

import dynamic from "next/dynamic";

export const StateSuburbExplorer = dynamic(
  () => import("./state-suburb-explorer").then((m) => m.StateSuburbExplorer),
  { ssr: false, loading: () => <div className="h-[520px] w-full animate-pulse rounded-xl bg-muted" /> },
);
