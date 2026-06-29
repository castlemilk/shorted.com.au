"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { ChoroplethMap } from "./choropleth-map";
import { MapLegend } from "./map-legend";
import { makePriceScale } from "@/lib/housing/price-scale";
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

  const { scale, priceMin, priceMax } = useMemo(() => {
    const vals = [...valueByStateCode.values()].filter((v) => v > 0);
    const max = vals.length ? Math.max(...vals) : 1;
    const min = vals.length ? Math.min(...vals) : 0;
    return { scale: makePriceScale(max), priceMin: min, priceMax: max };
  }, [valueByStateCode]);

  if (!topo) return <div className="h-[460px] w-full animate-pulse rounded-xl bg-muted" />;

  const objectName = Object.keys(topo.objects)[0]!;
  return (
    <ChoroplethMap
      topology={topo}
      objectName={objectName}
      valueById={valueById}
      nameById={nameById}
      colorScale={(v) => scale(v)}
      ariaLabel="Australian states by greater-capital median house price — click a state to drill in"
      legend={priceMax > 1 ? <MapLegend colorScale={(v) => scale(v)} min={priceMin} max={priceMax} label="Capital median price" showNoData={false} /> : null}
      onFeatureClick={(steCode) => {
        const state = STE_CODE_TO_STATE[steCode];
        if (state) router.push(`/housing/${stateSlug(state)}`);
      }}
    />
  );
}
