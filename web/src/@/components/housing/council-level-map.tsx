"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { Topology } from "topojson-specification";
import type { CouncilSummary } from "~/gen/shorts/v1alpha1/housing_pb";
import { ChoroplethMap, type OverlayLayer } from "./choropleth-map";
import { MapLegend } from "./map-legend";
import { councilTopology } from "@/lib/housing/council-geometry";
import { COUNCIL_METRIC_BY_KEY, councilMetricScale, type CouncilMetricKey } from "@/lib/housing/council-metrics";
import { councilHref } from "@/lib/housing/council";

const TIP_W = 220;
const TIP_H = 120;

/**
 * The state map at council level: one fill per council, merged on the fly from
 * the suburbs whose dominant council it is (council-geometry.ts). Colour comes
 * from ListCouncils through the council-metrics registry; a council with no
 * value for the metric hatches. Clicking a council opens its page.
 */
export function CouncilLevelMap({
  stateCode, topology, objectName, lgaBySal, councils, metricKey, overlays, legendExtra,
}: {
  stateCode: string;
  topology: Topology;
  objectName: string;
  lgaBySal: ReadonlyMap<string, string | null>;
  councils: readonly CouncilSummary[];
  metricKey: CouncilMetricKey;
  overlays?: OverlayLayer[];
  legendExtra?: React.ReactNode;
}) {
  const router = useRouter();
  const metric = COUNCIL_METRIC_BY_KEY[metricKey];
  const [hover, setHover] = useState<{ code: string; x: number; y: number } | null>(null);

  const derived = useMemo(() => councilTopology(topology, objectName, lgaBySal), [topology, objectName, lgaBySal]);
  const byCode = useMemo(() => new Map(councils.map((c) => [c.lgaCode, c])), [councils]);
  const { valueById, scale, min, max, nameById } = useMemo(() => {
    const values = new Map<string, number | null>();
    const names = new Map<string, string>();
    const present: number[] = [];
    for (const c of councils) {
      const v = metric.value(c);
      values.set(c.lgaCode, v);
      names.set(c.lgaCode, c.displayName);
      if (v != null) present.push(v);
    }
    return { valueById: values, nameById: names, ...councilMetricScale(metric, present) };
  }, [councils, metric]);
  // Frame on every council shape, so switching metric never moves the view.
  const fitValueById = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const c of councils) m.set(c.lgaCode, 1);
    return m;
  }, [councils]);

  const sample = councils.find((c) => metric.value(c) != null);
  const hovered = hover ? byCode.get(hover.code) : undefined;
  const hoveredValue = hovered ? metric.value(hovered) : null;

  const legend = (
    <div className="flex flex-col gap-1.5">
      <MapLegend
        colorScale={scale} min={min} max={max} label={metric.legendLabel} format={metric.format}
        noDataLabel={metric.noDataLabel} signed={metric.diverging}
      />
      <p className="pointer-events-none max-w-[240px] rounded-md bg-card/85 px-2 py-1 text-[10px] leading-snug text-muted-foreground backdrop-blur">
        {metric.source(sample)}. Council shapes join the suburbs each council holds most residents of (ABS mesh-block allocation).
      </p>
      {legendExtra}
    </div>
  );

  return (
    <>
      <ChoroplethMap
        fill
        topology={derived.topology}
        objectName={derived.objectName}
        valueById={valueById}
        colorScale={scale}
        fitValueById={fitValueById}
        fitToData
        nameById={nameById}
        hoveredId={hover?.code}
        ariaLabel={`${stateCode} councils by ${metric.label.toLowerCase()}`}
        legend={legend}
        overlays={overlays}
        onFeatureClick={(code) => {
          const c = byCode.get(code);
          const href = c ? councilHref(stateCode, c.slug) : null;
          if (href) router.push(href);
        }}
        onFeatureHover={(code, evt) => {
          if (!code || !evt) return setHover(null);
          setHover({ code, x: evt.clientX, y: evt.clientY });
        }}
      />
      {hover && hovered ? (
        <div
          className="pointer-events-none fixed z-50 w-[220px] rounded-lg border border-border bg-card/95 p-3 text-xs shadow-lg backdrop-blur"
          style={{
            left: hover.x + TIP_W + 18 > window.innerWidth ? hover.x - TIP_W - 14 : hover.x + 14,
            top: hover.y + TIP_H + 18 > window.innerHeight ? hover.y - TIP_H : hover.y + 14,
          }}
          role="status"
        >
          <div className="font-medium text-foreground">{hovered.displayName}</div>
          <div className="text-[11px] text-muted-foreground">
            {hovered.kind === "unincorporated" ? "Unincorporated area" : "Council"}
            {hovered.population > 0 ? ` · ${hovered.population.toLocaleString("en-AU")} residents (${hovered.erpYear})` : ""}
          </div>
          <div className="mt-1.5 flex items-baseline justify-between gap-2">
            <span className="text-muted-foreground">{metric.label}</span>
            <span className="font-mono tabular-nums text-foreground">
              {hoveredValue == null ? metric.noDataLabel : metric.format(hoveredValue)}
            </span>
          </div>
          {hovered.slug ? <div className="mt-1.5 text-[10px] text-primary">Click for the council page</div> : null}
        </div>
      ) : null}
    </>
  );
}
