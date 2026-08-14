"use client";

import { useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { scaleSequential } from "d3-scale";
import { interpolateYlOrRd } from "d3-scale-chromatic";

import type { StatePriceDropSummary } from "~/gen/shorts/v1alpha1/housing_pb";
import {
  STATE_NAMES,
  STATE_TO_STE_CODE,
  STE_CODE_TO_STATE,
  slugToState,
  stateSlug,
} from "@/lib/housing/states";
import { ChoroplethMap } from "../choropleth-map";
import { MapLegend } from "../map-legend";
import { useTopojson } from "../use-topojson";

export interface StateDropsMapProps {
  states: StatePriceDropSummary[];
}

const MAP_HEIGHT = 380;
const formatShare = (value: number) => `${value.toFixed(1)}%`;

/**
 * Client-only state comparison for the static /price-drops route. State rows
 * arrive from the server's already-cached overview response; only the committed
 * boundary asset is fetched after hydration.
 */
export function StateDropsMap({ states }: StateDropsMapProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const {
    data: topology,
    isLoading,
    isError,
  } = useTopojson("/geo/states.topojson");

  const { valueById, nameById, maxSharePct } = useMemo(() => {
    const values = new Map<string, number | null>();
    const names = new Map<string, string>();
    let max = 0;

    for (const state of states) {
      const featureId = STATE_TO_STE_CODE[state.stateCode];
      if (!featureId) continue;

      const sharePct = Math.min(100, Math.max(0, state.droppedShare * 100));
      values.set(featureId, sharePct);
      names.set(
        featureId,
        `${STATE_NAMES[state.stateCode] ?? state.stateCode} — ${formatShare(sharePct)} of tracked listings cut in 30 days`,
      );
      max = Math.max(max, sharePct);
    }

    return {
      valueById: values,
      nameById: names,
      maxSharePct: Math.max(max, 0.1),
    };
  }, [states]);

  const colorScale = useMemo(
    () =>
      scaleSequential((t: number) => interpolateYlOrRd(0.15 + 0.8 * t)).domain([
        0,
        maxSharePct,
      ]),
    [maxSharePct],
  );

  if (isError) {
    return (
      <div className="flex h-[380px] items-center justify-center rounded-xl border border-border bg-muted/30 p-6 text-center text-sm text-muted-foreground">
        Map unavailable — compare states in the table below.
      </div>
    );
  }

  if (isLoading || !topology) {
    return (
      <div className="h-[380px] w-full animate-pulse rounded-xl bg-muted" />
    );
  }

  const objectName = Object.keys(topology.objects)[0];
  if (!objectName) {
    return (
      <div className="flex h-[380px] items-center justify-center rounded-xl border border-border bg-muted/30 p-6 text-center text-sm text-muted-foreground">
        Map unavailable — compare states in the table below.
      </div>
    );
  }

  const selectedState = slugToState(searchParams.get("state") ?? "");
  const selectedId = selectedState
    ? STATE_TO_STE_CODE[selectedState]
    : undefined;

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <ChoroplethMap
        topology={topology}
        objectName={objectName}
        valueById={valueById}
        colorScale={colorScale}
        nameById={nameById}
        selectedId={selectedId}
        height={MAP_HEIGHT}
        ariaLabel="Australian states by share of tracked listings with an asking-price cut in the last 30 days"
        legend={
          <MapLegend
            colorScale={colorScale}
            min={0}
            max={maxSharePct}
            label="Listings cut (30d)"
            format={formatShare}
            noDataLabel="Not tracked"
          />
        }
        onFeatureClick={(featureId) => {
          const stateCode = STE_CODE_TO_STATE[featureId];
          if (!stateCode) return;

          const nextParams = new URLSearchParams(searchParams.toString());
          nextParams.set("state", stateSlug(stateCode));
          router.push(`/price-drops?${nextParams.toString()}`, {
            scroll: false,
          });
        }}
      />
    </div>
  );
}
