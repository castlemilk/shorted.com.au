"use client";

import { useMemo, useState } from "react";
import { ChoroplethMap } from "./choropleth-map";
import { MapLegend } from "./map-legend";
import { makePriceScale } from "@/lib/housing/price-scale";
import { useTopojson } from "./use-topojson";
import { SuburbTooltip } from "./suburb-tooltip";

export type SuburbDatum = {
  salCode: string; salName: string; postcode: string;
  latestMedianPrice: number; yoyPct: number;
  population: number; medianAge: number; medianWeeklyHhdIncome: number;
  regionCode?: string;
};

const TOOLTIP_W = 224;
const TOOLTIP_H = 200;

export function StateSuburbMap({
  stateCode, suburbs, selectedSalCode, hoveredSalCode, onSelect, onHover,
}: {
  stateCode: string; // e.g. "NSW"
  suburbs: SuburbDatum[];
  selectedSalCode?: string;
  hoveredSalCode?: string;
  onSelect: (salCode: string) => void;
  onHover?: (salCode: string | null) => void;
}) {
  const { data: topo, isLoading, isError } = useTopojson(`/geo/suburbs/${stateCode}.topojson`);
  const [hover, setHover] = useState<{ d: SuburbDatum; x: number; y: number } | null>(null);

  const byCode = useMemo(() => new Map(suburbs.map((s) => [s.salCode, s])), [suburbs]);
  const valueById = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const s of suburbs) m.set(s.salCode, s.latestMedianPrice > 0 ? s.latestMedianPrice : null);
    return m;
  }, [suburbs]);
  const nameById = useMemo(() => new Map(suburbs.map((s) => [s.salCode, s.salName])), [suburbs]);

  const { scale, priceMin, priceMax } = useMemo(() => {
    const vals = suburbs.map((s) => s.latestMedianPrice).filter((v) => v > 0);
    const max = vals.length ? Math.max(...vals) : 1;
    const min = vals.length ? Math.min(...vals) : 0;
    return { scale: makePriceScale(max), priceMin: min, priceMax: max };
  }, [suburbs]);

  if (isError) {
    return (
      <div className="flex h-[460px] w-full items-center justify-center rounded-xl border border-border bg-muted/30 p-6 text-center text-sm text-muted-foreground">
        Map unavailable — browse suburbs in the list.
      </div>
    );
  }
  if (isLoading || !topo) return <div className="h-[460px] w-full animate-pulse rounded-xl bg-muted" />;
  const objectName = Object.keys(topo.objects)[0]!;
  const hasPrice = priceMax > 1;

  return (
    <div className="relative">
      <ChoroplethMap
        topology={topo}
        objectName={objectName}
        valueById={valueById}
        nameById={nameById}
        colorScale={(v) => scale(v)}
        selectedId={selectedSalCode}
        hoveredId={hoveredSalCode}
        fitToData
        ariaLabel={`${stateCode} suburbs by median house price`}
        legend={hasPrice ? <MapLegend colorScale={(v) => scale(v)} min={priceMin} max={priceMax} /> : null}
        onFeatureClick={(id) => onSelect(id)}
        onFeatureHover={(id, evt) => {
          onHover?.(id);
          if (!id || !evt) return setHover(null);
          const d = byCode.get(id);
          if (d) setHover({ d, x: evt.clientX, y: evt.clientY });
        }}
      />
      {hover ? (
        <div
          className="pointer-events-none fixed z-50"
          style={{
            left: hover.x + TOOLTIP_W + 18 > window.innerWidth ? hover.x - TOOLTIP_W - 14 : hover.x + 14,
            top: hover.y + TOOLTIP_H + 18 > window.innerHeight ? hover.y - TOOLTIP_H : hover.y + 14,
          }}
        >
          <SuburbTooltip summary={hover.d} regionCode={hover.d.regionCode} />
        </div>
      ) : null}
    </div>
  );
}
