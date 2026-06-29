"use client";

import { useMemo, useState } from "react";
import { scaleSequentialSqrt } from "d3-scale";
import { interpolateYlOrRd } from "d3-scale-chromatic";
import { ChoroplethMap } from "./choropleth-map";
import { useTopojson } from "./use-topojson";
import { SuburbTooltip } from "./suburb-tooltip";

export type SuburbDatum = {
  salCode: string; salName: string; postcode: string;
  latestMedianPrice: number; yoyPct: number;
  population: number; medianAge: number; medianWeeklyHhdIncome: number;
  regionCode?: string;
};

export function StateSuburbMap({
  stateCode, suburbs, selectedSalCode, onSelect,
}: {
  stateCode: string; // e.g. "NSW"
  suburbs: SuburbDatum[];
  selectedSalCode?: string;
  onSelect: (salCode: string) => void;
}) {
  const { data: topo } = useTopojson(`/geo/suburbs/${stateCode}.topojson`);
  const [hover, setHover] = useState<{ d: SuburbDatum; x: number; y: number } | null>(null);

  const byCode = useMemo(() => new Map(suburbs.map((s) => [s.salCode, s])), [suburbs]);
  const valueById = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const s of suburbs) m.set(s.salCode, s.latestMedianPrice > 0 ? s.latestMedianPrice : null);
    return m;
  }, [suburbs]);
  const nameById = useMemo(() => new Map(suburbs.map((s) => [s.salCode, s.salName])), [suburbs]);

  const colorScale = useMemo(() => {
    const vals = suburbs.map((s) => s.latestMedianPrice).filter((v) => v > 0);
    const max = Math.max(1, ...vals);
    return scaleSequentialSqrt(interpolateYlOrRd).domain([0, max]);
  }, [suburbs]);

  if (!topo) return <div className="h-[460px] w-full animate-pulse rounded-xl bg-muted" />;
  const objectName = Object.keys(topo.objects)[0]!;

  return (
    <div className="relative">
      <ChoroplethMap
        topology={topo}
        objectName={objectName}
        valueById={valueById}
        nameById={nameById}
        colorScale={(v) => colorScale(v)}
        selectedId={selectedSalCode}
        ariaLabel={`${stateCode} suburbs by median house price`}
        onFeatureClick={(id) => onSelect(id)}
        onFeatureHover={(id, evt) => {
          if (!id || !evt) return setHover(null);
          const d = byCode.get(id);
          if (d) setHover({ d, x: evt.clientX, y: evt.clientY });
        }}
      />
      {hover ? (
        <div className="fixed z-50" style={{ left: hover.x + 14, top: hover.y + 14 }}>
          <SuburbTooltip summary={hover.d} regionCode={hover.d.regionCode} />
        </div>
      ) : null}
    </div>
  );
}
