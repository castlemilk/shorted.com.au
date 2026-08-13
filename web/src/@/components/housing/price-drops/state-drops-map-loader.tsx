"use client";

import dynamic from "next/dynamic";

import type { StateDropsMapProps } from "./state-drops-map";

// d3/topojson measures in the browser; keep the heavy map runtime out of SSR.
export const StateDropsMap = dynamic<StateDropsMapProps>(
  () => import("./state-drops-map").then((module) => module.StateDropsMap),
  {
    ssr: false,
    loading: () => (
      <div className="h-[380px] w-full animate-pulse rounded-xl bg-muted" />
    ),
  },
);

export type { StateDropsMapProps };
