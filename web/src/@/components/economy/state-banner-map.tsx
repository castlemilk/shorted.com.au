"use client";

import { useMemo } from "react";

import { useTopojson } from "@/components/housing/use-topojson";
import type { StateSlug } from "@/lib/economy/map-metrics";
import {
  buildStateSilhouetteModel,
  STATE_SILHOUETTE_FRAME,
} from "./state-banner-geometry";

export function StateBannerMap({
  state,
  name,
}: {
  state: StateSlug;
  name: string;
}) {
  const { data: topology } = useTopojson("/geo/states.topojson");
  const model = useMemo(
    () => (topology ? buildStateSilhouetteModel(topology, state) : null),
    [state, topology],
  );

  if (!model) {
    return (
      <div
        aria-hidden="true"
        className="h-full w-full animate-pulse bg-muted/30"
      />
    );
  }

  const { width, height } = STATE_SILHOUETTE_FRAME;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMidYMid meet"
      className="h-full w-full"
      role="img"
      aria-label={`${name} silhouette`}
      data-feature-id={model.featureId}
    >
      <path
        d={model.d}
        className="fill-primary text-foreground"
        fillOpacity={0.72}
        stroke="currentColor"
        strokeOpacity={0.72}
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
