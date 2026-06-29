"use client";

import { useMemo, useState } from "react";
import { ChoroplethMap } from "./choropleth-map";
import { MapLegend } from "./map-legend";
import { CategoricalLegend } from "./categorical-legend";
import { makePriceScale } from "@/lib/housing/price-scale";
import {
  HIGHLIGHT_METRICS, METRIC_BY_KEY, amberScale, type MetricKey,
} from "@/lib/housing/highlight-metrics";
import { useTopojson } from "./use-topojson";
import { SuburbTooltip } from "./suburb-tooltip";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

export type SuburbDatum = {
  salCode: string; salName: string; postcode: string;
  latestMedianPrice: number; yoyPct: number;
  population: number; medianAge: number; medianWeeklyHhdIncome: number;
  pctBornOverseas: number; topReligion: string; topLanguage: string; pctTopLanguage: number;
  federalDivision: string; federalMember: string; federalParty: string;
  federalPartyAb: string; federalTppAlp: number;
  regionCode?: string;
};

const TOOLTIP_W = 224;
const TOOLTIP_H = 220;

export function StateSuburbMap({
  stateCode, suburbs, selectedSalCode, hoveredSalCode, onSelect, onHover, onOpenProfile,
}: {
  stateCode: string; // e.g. "NSW"
  suburbs: SuburbDatum[];
  selectedSalCode?: string;
  hoveredSalCode?: string;
  onSelect: (salCode: string | null) => void;
  onHover?: (salCode: string | null) => void;
  onOpenProfile: (salCode: string) => void;
}) {
  const { data: topo, isLoading, isError } = useTopojson(`/geo/suburbs/${stateCode}.topojson`);
  const [hover, setHover] = useState<{ d: SuburbDatum; x: number; y: number } | null>(null);
  const [metricKey, setMetricKey] = useState<MetricKey>("price");
  const metric = METRIC_BY_KEY[metricKey];

  const byCode = useMemo(() => new Map(suburbs.map((s) => [s.salCode, s])), [suburbs]);

  // Stable price map — drives the price metric AND the fitToData framing (kept
  // independent of the toggled metric so switching never resets the zoom).
  const priceValueById = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const s of suburbs) m.set(s.salCode, s.latestMedianPrice > 0 ? s.latestMedianPrice : null);
    return m;
  }, [suburbs]);
  const priceScale = useMemo(() => {
    const vals = suburbs.map((s) => s.latestMedianPrice).filter((v) => v > 0);
    const max = vals.length ? Math.max(...vals) : 1;
    const min = vals.length ? Math.min(...vals) : 0;
    return { scale: makePriceScale(max), min, max };
  }, [suburbs]);
  const nameById = useMemo(() => new Map(suburbs.map((s) => [s.salCode, s.salName])), [suburbs]);

  // Continuous metric → value map + amber scale over its own range.
  const continuous = useMemo(() => {
    if (metric.kind !== "continuous") return null;
    if (metric.key === "price") {
      return { valueById: priceValueById, scale: priceScale.scale, min: priceScale.min, max: priceScale.max };
    }
    const m = new Map<string, number | null>();
    const vals: number[] = [];
    for (const s of suburbs) {
      const v = metric.value(s);
      m.set(s.salCode, v);
      if (v != null) vals.push(v);
    }
    const [min, max] = metric.domain ?? [
      vals.length ? Math.min(...vals) : 0,
      vals.length ? Math.max(...vals) : 1,
    ];
    const scale = metric.makeScale ? metric.makeScale(min, max) : amberScale(min, max, metric.sqrt);
    return { valueById: m, scale, min, max };
  }, [metric, suburbs, priceValueById, priceScale]);

  // Categorical metric → category map + the legend entries actually present.
  const categorical = useMemo(() => {
    if (metric.kind !== "categorical") return null;
    const m = new Map<string, string | null>();
    const present = new Set<string>();
    for (const s of suburbs) {
      const c = metric.category(s);
      m.set(s.salCode, c);
      if (c) present.add(c);
    }
    const entries = metric.order.filter((o) => present.has(o)).map((o) => ({ label: o, color: metric.colorFor(o) }));
    return { categoryById: m, entries };
  }, [metric, suburbs]);

  const metricSelect = (
    <Select value={metricKey} onValueChange={(v) => setMetricKey(v as MetricKey)}>
      <SelectTrigger aria-label="Colour the map by" className="h-8 w-[190px] text-xs">
        <span className="text-muted-foreground">Colour by:&nbsp;</span><SelectValue />
      </SelectTrigger>
      <SelectContent>
        {HIGHLIGHT_METRICS.map((m) => (
          <SelectItem key={m.key} value={m.key}>{m.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  if (isError) {
    return (
      <div className="flex h-[460px] w-full items-center justify-center rounded-xl border border-border bg-muted/30 p-6 text-center text-sm text-muted-foreground">
        Map unavailable — browse suburbs in the list.
      </div>
    );
  }
  if (isLoading || !topo) {
    return (
      <div className="flex flex-1 flex-col">
        <div className="mb-2">{metricSelect}</div>
        <div className="h-full min-h-[460px] w-full animate-pulse rounded-xl bg-muted" />
      </div>
    );
  }
  const objectName = Object.keys(topo.objects)[0]!;
  const selected = selectedSalCode ? byCode.get(selectedSalCode) : undefined;

  const legend = metric.kind === "categorical"
    ? (categorical?.entries.length
        ? <CategoricalLegend label={metric.legendLabel} entries={categorical.entries} />
        : null)
    : (continuous
        ? <MapLegend
            colorScale={(v) => continuous.scale(v)} min={continuous.min} max={continuous.max}
            label={metric.legendLabel} format={metric.format}
            noDataLabel={metric.key === "price" ? "No price data" : "No data"} />
        : null);

  return (
    <div className="flex flex-1 flex-col">
      <div className="mb-2 flex items-center justify-between gap-2">
        {metricSelect}
      </div>

      <div className="relative flex flex-1 flex-col">
        <ChoroplethMap
          fill
          topology={topo}
          objectName={objectName}
          valueById={continuous?.valueById ?? priceValueById}
          colorScale={(v) => (continuous?.scale ?? priceScale.scale)(v)}
          categoryById={categorical?.categoryById}
          categoryColor={metric.kind === "categorical" ? metric.colorFor : undefined}
          fitValueById={priceValueById}
          nameById={nameById}
          selectedId={selectedSalCode}
          hoveredId={hoveredSalCode}
          focusId={selectedSalCode}
          fitToData
          ariaLabel={`${stateCode} suburbs by ${metric.label}`}
          legend={legend}
          onFeatureClick={(id) => onSelect(id)}
          onFeatureHover={(id, evt) => {
            onHover?.(id);
            if (!id || !evt) return setHover(null);
            const d = byCode.get(id);
            if (d) setHover({ d, x: evt.clientX, y: evt.clientY });
          }}
        />

        {/* Selected suburb: persistent, interactive card with a profile CTA. */}
        {selected ? (
          <div className="absolute left-2 top-2 z-20">
            <SuburbTooltip
              summary={selected}
              regionCode={selected.regionCode}
              onOpenProfile={() => onOpenProfile(selected.salCode)}
              onClose={() => onSelect(null)}
            />
          </div>
        ) : null}

        {/* Hover card (transient, at cursor) — suppressed while a suburb is selected. */}
        {hover && !selected ? (
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
    </div>
  );
}
