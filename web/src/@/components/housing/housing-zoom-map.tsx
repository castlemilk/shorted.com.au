"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { geoMercator, geoPath } from "d3-geo";
import { zoom as d3zoom, zoomIdentity, type ZoomBehavior, type D3ZoomEvent } from "d3-zoom";
import { select } from "d3-selection";
import { easeCubicInOut } from "d3-ease";
import { feature } from "topojson-client";
import type { Topology, GeometryCollection } from "topojson-specification";
import type { Feature, Geometry } from "geojson";
import { ParentSize } from "@visx/responsive";
import { useQuery } from "@tanstack/react-query";
import { listStateSuburbsClient } from "~/app/actions/client/getHousingClient";
import { makePriceScale, fmtPriceShort } from "@/lib/housing/price-scale";
import {
  STE_CODE_TO_STATE, STATE_NAMES, stateSlug, suburbHref,
} from "@/lib/housing/states";
import { featureFill } from "./choropleth-map";
import { useTopojson } from "./use-topojson";
import { MapLegend } from "./map-legend";

/**
 * One continuously-zoomable Australia map: states (coloured by capital-city
 * median), and when you enter a state it flies in and reveals that state's
 * suburb medians in-place — a SINGLE national projection + one persistent
 * d3-zoom, so it feels like moving elastically in and out of states rather than
 * hopping between separate maps. Suburbs are projected with the same national
 * projection, so they sit exactly where the state is when you zoom in.
 */
export function HousingZoomMap({ valueByStateCode }: { valueByStateCode: Map<string, number> }) {
  const { data: statesTopo } = useTopojson("/geo/states.topojson");
  return (
    <div className="relative h-[520px] w-full">
      <ParentSize>{({ width, height }) =>
        width > 0 && height > 0 && statesTopo
          ? <ZoomInner statesTopo={statesTopo} valueByStateCode={valueByStateCode} width={width} height={height} />
          : <div className="h-full w-full animate-pulse rounded-xl bg-muted" />
      }</ParentSize>
    </div>
  );
}

const ENTER_MS = 850;
const EXIT_MS = 650;

function reduceMotion() {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function ZoomInner({
  statesTopo, valueByStateCode, width, height,
}: {
  statesTopo: Topology; valueByStateCode: Map<string, number>; width: number; height: number;
}) {
  const router = useRouter();
  const svgRef = useRef<SVGSVGElement>(null);
  const gRef = useRef<SVGGElement>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);

  const [active, setActive] = useState<string | null>(null); // active state code (NSW…)
  const [hover, setHover] = useState<{ name: string; price: number; x: number; y: number } | null>(null);

  // One national projection for EVERYTHING (states + any state's suburbs).
  const { projection, path, stateFeatures, stateById } = useMemo(() => {
    const obj = statesTopo.objects[Object.keys(statesTopo.objects)[0]!] as GeometryCollection;
    const fc = feature(statesTopo, obj) as unknown as { features: Feature<Geometry>[] };
    const proj = geoMercator().fitSize([width, height], { type: "FeatureCollection", features: fc.features } as never);
    const p = geoPath(proj);
    const byId = new Map<string, Feature<Geometry>>();
    for (const f of fc.features) byId.set(String(f.id), f);
    return { projection: proj, path: p, stateFeatures: fc.features, stateById: byId };
  }, [statesTopo, width, height]);

  // Active state's suburbs: data (medians) + boundaries, both lazy.
  const { data: suburbResp } = useQuery({
    queryKey: ["zoom-state-suburbs", active],
    queryFn: () => listStateSuburbsClient(active!, "", 5000),
    enabled: !!active,
    staleTime: 60 * 60 * 1000,
  });
  const { data: suburbTopo } = useTopojson(active ? `/geo/suburbs/${active}.topojson` : null);

  const suburb = useMemo(() => {
    if (!active || !suburbTopo || !suburbResp?.suburbs) return null;
    const priceById = new Map<string, number | null>();
    const nameById = new Map<string, string>();
    const vals: number[] = [];
    for (const s of suburbResp.suburbs) {
      const v = s.latestMedianPrice > 0 ? s.latestMedianPrice : null;
      priceById.set(s.salCode, v);
      nameById.set(s.salCode, s.salName);
      if (v) vals.push(v);
    }
    const obj = suburbTopo.objects[Object.keys(suburbTopo.objects)[0]!] as GeometryCollection;
    const fc = feature(suburbTopo, obj) as unknown as { features: Feature<Geometry>[] };
    const max = vals.length ? Math.max(...vals) : 1;
    const min = vals.length ? Math.min(...vals) : 0;
    const byCode = new Map(suburbResp.suburbs.map((s) => [s.salCode, s]));
    return { features: fc.features, priceById, nameById, byCode, scale: makePriceScale(max), min, max };
  }, [active, suburbTopo, suburbResp]);

  // Colour scale for the national (state) layer.
  const stateScale = useMemo(() => {
    const vals = [...valueByStateCode.values()].filter((v) => v > 0);
    const max = vals.length ? Math.max(...vals) : 1;
    return makePriceScale(max);
  }, [valueByStateCode]);

  // Transform that frames a feature's bounds into the viewport (like ChoroplethMap).
  function frameOf(f: Feature<Geometry>, padding: number) {
    const [[x0, y0], [x1, y1]] = path.bounds(f as never);
    const bw = x1 - x0, bh = y1 - y0;
    if (!(bw > 0) || !(bh > 0)) return zoomIdentity;
    const scale = Math.max(1, Math.min(60, padding / Math.max(bw / width, bh / height)));
    return zoomIdentity.translate(width / 2 - scale * (x0 + x1) / 2, height / 2 - scale * (y0 + y1) / 2).scale(scale);
  }

  // Set up the persistent d3-zoom once per projection.
  useEffect(() => {
    if (!svgRef.current || !gRef.current) return;
    const svg = select(svgRef.current);
    const g = select(gRef.current);
    const zoomBehavior = d3zoom<SVGSVGElement, unknown>()
      .scaleExtent([1, 60])
      .on("zoom", (e: D3ZoomEvent<SVGSVGElement, unknown>) => g.attr("transform", e.transform.toString()));
    zoomRef.current = zoomBehavior;
    svg.call(zoomBehavior);
    svg.on("dblclick.zoom", null);
    zoomBehavior.transform(svg, zoomIdentity);
    return () => { svg.on(".zoom", null); zoomRef.current = null; };
  }, [projection, width, height]);

  function flyTo(transform: ReturnType<typeof frameOf>, ms: number) {
    if (!zoomRef.current || !svgRef.current) return;
    const svg = select(svgRef.current);
    const dur = reduceMotion() ? 0 : ms;
    zoomRef.current.transform(svg.transition().duration(dur).ease(easeCubicInOut), transform);
  }

  function enterState(steCode: string) {
    const state = STE_CODE_TO_STATE[steCode];
    const f = stateById.get(steCode);
    if (!state || !f) return;
    setActive(state);
    setHover(null);
    flyTo(frameOf(f, 0.82), ENTER_MS);
    if (typeof window !== "undefined") window.history.replaceState(null, "", `/housing/${stateSlug(state)}`);
  }
  function exitToAustralia() {
    setActive(null);
    setHover(null);
    flyTo(zoomIdentity, EXIT_MS);
    if (typeof window !== "undefined") window.history.replaceState(null, "", "/housing");
  }

  return (
    <>
      <svg
        ref={svgRef} width={width} height={height} role="group"
        aria-label="Zoomable map of Australian house prices — click a state to fly into its suburbs"
        style={{ touchAction: "pan-y", display: "block", cursor: active ? "default" : "pointer" }}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <pattern id="zoom-nodata" width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width={6} height={6} style={{ fill: "hsl(var(--muted))" }} />
            <line x1={0} y1={0} x2={0} y2={6} strokeWidth={1} style={{ stroke: "hsl(var(--border))" }} />
          </pattern>
        </defs>
        <g ref={gRef}>
          {/* National states layer — dims out as you enter a state */}
          <g style={{ opacity: active ? 0.12 : 1, transition: reduceMotion() ? undefined : "opacity 500ms ease", pointerEvents: active ? "none" : undefined }}>
            {stateFeatures.map((f) => {
              const state = STE_CODE_TO_STATE[String(f.id)];
              const v = state ? valueByStateCode.get(state) ?? null : null;
              return (
                <path
                  key={String(f.id)} d={path(f as never) ?? ""}
                  fill={featureFill(v && v > 0 ? v : null, (x) => stateScale(x))}
                  style={{ stroke: "hsl(var(--border))", strokeWidth: 0.6, vectorEffect: "non-scaling-stroke" }}
                  onClick={() => enterState(String(f.id))}
                  onPointerMove={(e) => {
                    if (active !== null || !state) return;
                    setHover({ name: STATE_NAMES[state] ?? state, price: v ?? 0, x: e.clientX, y: e.clientY });
                  }}
                />
              );
            })}
          </g>

          {/* Active state's suburb layer — fades in on top, in the same projection */}
          {suburb ? (
            <g style={{ opacity: 1, transition: reduceMotion() ? undefined : "opacity 500ms ease" }}>
              {suburb.features.map((f) => {
                const id = String(f.id);
                const v = suburb.priceById.get(id);
                return (
                  <path
                    key={id} d={path(f as never) ?? ""}
                    fill={featureFill(v, (x) => suburb.scale(x))}
                    style={{ stroke: "hsl(var(--border))", strokeWidth: 0.4, vectorEffect: "non-scaling-stroke", cursor: "pointer" }}
                    onPointerMove={(e) => setHover({ name: suburb.nameById.get(id) ?? id, price: v ?? 0, x: e.clientX, y: e.clientY })}
                    onClick={() => {
                      const s = suburb.byCode.get(id);
                      if (s && active) router.push(suburbHref(active, { salName: s.salName, salCode: s.salCode, postcode: s.postcode }));
                    }}
                  />
                );
              })}
            </g>
          ) : null}
        </g>
      </svg>

      {/* Back-to-Australia control */}
      {active ? (
        <button
          type="button" onClick={exitToAustralia}
          className="absolute left-2 top-2 z-20 flex items-center gap-1.5 rounded-md border border-border bg-card/90 px-2.5 py-1.5 text-xs font-medium text-foreground shadow-sm backdrop-blur transition-colors hover:bg-muted"
        >
          ‹ Australia
          <span className="text-muted-foreground">· {STATE_NAMES[active] ?? active} suburbs</span>
        </button>
      ) : null}

      {/* Legend */}
      {active && suburb && suburb.max > 1 ? (
        <div className="absolute bottom-2 left-2 z-10">
          <MapLegend colorScale={(v) => suburb.scale(v)} min={suburb.min} max={suburb.max} label={`${STATE_NAMES[active]} median house price`} />
        </div>
      ) : null}

      {/* Hover tooltip */}
      {hover ? (
        <div
          className="pointer-events-none fixed z-50 rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md"
          style={{ left: hover.x + 12, top: hover.y + 12 }}
        >
          <span className="font-medium capitalize">{hover.name.toLowerCase()}</span>
          {hover.price > 0 ? <span className="ml-1.5 font-mono tabular-nums text-muted-foreground">{fmtPriceShort(hover.price)}</span> : <span className="ml-1.5 text-muted-foreground">no price</span>}
        </div>
      ) : null}

      {/* Hint */}
      {!active ? (
        <div className="pointer-events-none absolute bottom-2 right-2 z-10 rounded-md bg-card/80 px-2 py-1 text-[11px] text-muted-foreground backdrop-blur">
          Click a state to fly in
        </div>
      ) : null}
    </>
  );
}
