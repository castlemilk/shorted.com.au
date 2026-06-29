"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { scaleSequential } from "d3-scale";
import { interpolateBlues } from "d3-scale-chromatic";
import { ChoroplethMap } from "./choropleth-map";
import { useTopojson } from "./use-topojson";
import { STE_CODE_TO_STATE, STATE_NAMES, stateSlug } from "@/lib/housing/states";

/** value keyed by STE_CODE21 (the topojson feature id). */
export function NationalHousingMap({
  valueByStateCode,
}: {
  /** state code (NSW…) → metric value (e.g. median price). */
  valueByStateCode: Map<string, number>;
}) {
  const router = useRouter();
  const { data: topo } = useTopojson("/geo/states.topojson");

  const valueById = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const [steCode, state] of Object.entries(STE_CODE_TO_STATE)) {
      const v = valueByStateCode.get(state);
      m.set(steCode, v ?? null);
    }
    return m;
  }, [valueByStateCode]);

  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const [steCode, state] of Object.entries(STE_CODE_TO_STATE)) m.set(steCode, STATE_NAMES[state] ?? state);
    return m;
  }, []);

  const colorScale = useMemo(() => {
    const vals = [...valueByStateCode.values()];
    const max = Math.max(1, ...vals);
    return scaleSequential(interpolateBlues).domain([0, max]);
  }, [valueByStateCode]);

  if (!topo) return <div className="h-[460px] w-full animate-pulse rounded-xl bg-muted" />;

  const objectName = Object.keys(topo.objects)[0]!;
  return (
    <ChoroplethMap
      topology={topo}
      objectName={objectName}
      valueById={valueById}
      nameById={nameById}
      colorScale={(v) => colorScale(v)}
      ariaLabel="Australian states by median house price — click a state to drill in"
      onFeatureClick={(steCode) => {
        const state = STE_CODE_TO_STATE[steCode];
        if (state) router.push(`/housing/${stateSlug(state)}`);
      }}
    />
  );
}
