"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { geoMercator, geoPath } from "d3-geo";
import { zoom as d3zoom, zoomIdentity, type ZoomBehavior, type D3ZoomEvent, type ZoomTransform } from "d3-zoom";
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
import { suburbLayerStatus } from "@/lib/housing/suburb-layer-status";
import {
  detailLevelForScale, viewportInProjected, projectedCenter, cullFeatures,
  focusedStateFor, boundsArea, CULL_CAP,
  type Bounds, type BoundedFeature, type StateStat,
} from "@/lib/housing/map-lod";
import { featureFill } from "./choropleth-map";
import { useTopojson } from "./use-topojson";
import { MapLegend } from "./map-legend";

/**
 * One continuously-zoomable Australia map with LEVEL-OF-DETAIL rendering:
 * - National view: 8 state paths, coloured by capital-city median; hovering a
 *   state shows a stat card. No suburbs are rendered.
 * - Zoom past the switch scale (by scroll/pinch OR by clicking a state), and the
 *   focused state's suburbs fade in — but ONLY the suburbs whose bounds fall in
 *   the current viewport (capped), so the DOM stays small at any state size.
 * Zoom back out and the suburb layer unmounts entirely.
 */
export function HousingZoomMap({ stateStats }: { stateStats: Map<string, StateStat> }) {
  const { data: statesTopo } = useTopojson("/geo/states.topojson");
  return (
    <div className="relative h-[520px] w-full">
      <ParentSize>{({ width, height }) =>
        width > 0 && height > 0 && statesTopo
          ? <ZoomInner statesTopo={statesTopo} stateStats={stateStats} width={width} height={height} />
          : <div className="h-full w-full animate-pulse rounded-xl bg-muted" />
      }</ParentSize>
    </div>
  );
}

const ENTER_MS = 850;
const EXIT_MS = 650;
const EXIT_SCALE = 1.5; // zoom back out below this and we drop the entered state
const VIEW_THROTTLE_MS = 120; // cap suburb re-cull re-renders during a gesture

function reduceMotion() {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// A suburb feature with its precomputed projected path string + bounds (so we
// never recompute geometry per culled frame).
type SuburbFeat = BoundedFeature<Feature<Geometry>> & { d: string };

const STROKE = "hsl(var(--border))";

function ZoomInner({
  statesTopo, stateStats, width, height,
}: {
  statesTopo: Topology; stateStats: Map<string, StateStat>; width: number; height: number;
}) {
  const router = useRouter();
  const svgRef = useRef<SVGSVGElement>(null);
  const gRef = useRef<SVGGElement>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const transformRef = useRef<ZoomTransform>(zoomIdentity);

  // Live view (drives LOD + culling). The zoom handler moves the <g> via d3 every
  // frame; React only re-renders on a throttled cadence + at gesture end.
  const [view, setView] = useState({ k: 1, x: 0, y: 0 });
  const lastViewAt = useRef(0);
  const pendingTimer = useRef<number | null>(null);

  // A state the user explicitly clicked into — keeps suburb detail even if that
  // big state frames below the pure-zoom switch scale. Cleared on zoom-out.
  const [enteredState, setEnteredState] = useState<string | null>(null);

  const [hover, setHover] = useState<
    | { kind: "state"; state: string; x: number; y: number }
    | { kind: "suburb"; name: string; price: number; x: number; y: number }
    | null
  >(null);

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

  // State projected bounds, for resolving which state the viewport is centred on.
  const stateBounds = useMemo(
    () => stateFeatures.map((f) => ({ id: String(f.id), bounds: path.bounds(f as never) as Bounds })),
    [stateFeatures, path],
  );

  // Derive the level of detail + focused state from the live view. Suburb detail
  // when zoomed past the switch scale OR when a state was explicitly entered.
  const pastSwitch = detailLevelForScale(view.k) === "suburb";
  const detail: "national" | "suburb" = pastSwitch || enteredState ? "suburb" : "national";
  // Past the switch scale follow the state under the viewport centre (so panning
  // across a border loads the right state); below it, stick to the entered state.
  const centerState = pastSwitch
    ? STE_CODE_TO_STATE[focusedStateFor(projectedCenter(view.k, view.x, view.y, width, height), stateBounds) ?? ""] ?? null
    : null;
  const focusedState = pastSwitch ? (centerState ?? enteredState) : enteredState;

  // Ref so the (resize-triggered) zoom-setup effect can reframe the focused state.
  const focusedStateRef = useRef<string | null>(null);
  focusedStateRef.current = focusedState;

  // Focused state's suburbs: medians + boundaries, both lazy + cached.
  const { data: suburbResp, isFetching: suburbFetching, refetch: refetchSuburbs } = useQuery({
    queryKey: ["zoom-state-suburbs", focusedState],
    queryFn: () => listStateSuburbsClient(focusedState!, "", 5000),
    enabled: !!focusedState,
    staleTime: 60 * 60 * 1000,
  });
  const { data: suburbTopo, isFetching: topoFetching, refetch: refetchTopo } = useTopojson(
    focusedState ? `/geo/suburbs/${focusedState}.topojson` : null,
  );

  // Build the suburb layer: price/name lookups, a colour scale over ALL values
  // (stable legend), and each feature's precomputed path + projected bounds.
  const suburb = useMemo(() => {
    if (!focusedState || !suburbTopo || !suburbResp?.suburbs) return null;
    const priceById = new Map<string, number | null>();
    const nameById = new Map<string, string>();
    const byCode = new Map(suburbResp.suburbs.map((s) => [s.salCode, s]));
    const vals: number[] = [];
    for (const s of suburbResp.suburbs) {
      const v = s.latestMedianPrice > 0 ? s.latestMedianPrice : null;
      priceById.set(s.salCode, v);
      nameById.set(s.salCode, s.salName);
      if (v) vals.push(v);
    }
    const obj = suburbTopo.objects[Object.keys(suburbTopo.objects)[0]!] as GeometryCollection;
    const fc = feature(suburbTopo, obj) as unknown as { features: Feature<Geometry>[] };
    const bounded: SuburbFeat[] = fc.features.map((f) => {
      const b = path.bounds(f as never) as Bounds;
      return { id: String(f.id), feature: f, bounds: b, area: boundsArea(b), d: path(f as never) ?? "" };
    });
    const max = vals.length ? Math.max(...vals) : 1;
    const min = vals.length ? Math.min(...vals) : 0;
    return { bounded, priceById, nameById, byCode, scale: makePriceScale(max), min, max };
  }, [focusedState, suburbTopo, suburbResp, path]);

  // Viewport-culled subset actually rendered (the efficiency win).
  const visibleSuburbs = useMemo(() => {
    if (detail !== "suburb" || !suburb) return [];
    const vp = viewportInProjected(view.k, view.x, view.y, width, height);
    return cullFeatures(suburb.bounded, vp, CULL_CAP);
  }, [detail, suburb, view, width, height]);

  // Colour scale for the national (state) layer, by capital-city median.
  const stateScale = useMemo(() => {
    const vals = [...stateStats.values()].map((s) => s.median).filter((v) => v > 0);
    const max = vals.length ? Math.max(...vals) : 1;
    return makePriceScale(max);
  }, [stateStats]);

  // Transform that frames a feature into the viewport.
  function frameOf(f: Feature<Geometry>, padding: number) {
    const [[x0, y0], [x1, y1]] = path.bounds(f as never);
    const bw = x1 - x0, bh = y1 - y0;
    if (!(bw > 0) || !(bh > 0)) return zoomIdentity;
    const scale = Math.max(1, Math.min(60, padding / Math.max(bw / width, bh / height)));
    return zoomIdentity.translate(width / 2 - scale * (x0 + x1) / 2, height / 2 - scale * (y0 + y1) / 2).scale(scale);
  }

  // Keep URL in sync with the focused state (deep-link + back-button friendly).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = focusedState ? `/housing/${stateSlug(focusedState)}` : "/housing";
    if (window.location.pathname !== url) window.history.replaceState(null, "", url);
  }, [focusedState]);

  // Persistent d3-zoom, re-created when the projection changes (resize). View
  // updates are throttled; a resize re-applies the focused state's framing so the
  // viewport doesn't snap back to national while the controls still show a state.
  useEffect(() => {
    if (!svgRef.current || !gRef.current) return;
    const svg = select(svgRef.current);
    const g = select(gRef.current);

    const flushView = () => {
      lastViewAt.current = performance.now();
      const t = transformRef.current;
      setView({ k: t.k, x: t.x, y: t.y });
    };
    const scheduleView = () => {
      const dt = performance.now() - lastViewAt.current;
      if (dt >= VIEW_THROTTLE_MS) { flushView(); return; }
      if (pendingTimer.current == null) {
        pendingTimer.current = window.setTimeout(() => { pendingTimer.current = null; flushView(); }, VIEW_THROTTLE_MS - dt);
      }
    };

    const zoomBehavior = d3zoom<SVGSVGElement, unknown>()
      .scaleExtent([1, 60])
      .on("zoom", (e: D3ZoomEvent<SVGSVGElement, unknown>) => {
        g.attr("transform", e.transform.toString());
        transformRef.current = e.transform;
        scheduleView();
      })
      .on("end", () => {
        flushView();
        if (transformRef.current.k < EXIT_SCALE) setEnteredState(null);
      });
    zoomRef.current = zoomBehavior;
    svg.call(zoomBehavior);
    svg.on("dblclick.zoom", null);

    const activeFeature = focusedStateRef.current
      ? stateFeatures.find((f) => STE_CODE_TO_STATE[String(f.id)] === focusedStateRef.current)
      : undefined;
    const initial = activeFeature ? frameOf(activeFeature, 0.82) : zoomIdentity;
    zoomBehavior.transform(svg, initial);
    transformRef.current = initial;
    flushView();

    return () => {
      svg.on(".zoom", null);
      zoomRef.current = null;
      if (pendingTimer.current != null) { clearTimeout(pendingTimer.current); pendingTimer.current = null; }
    };
    // `focusedStateRef`/`frameOf`/`stateFeatures` are intentionally read but omitted
    // from deps: this must re-run ONLY on projection/size change, not per view tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    setEnteredState(state);
    setHover(null);
    flyTo(frameOf(f, 0.82), ENTER_MS);
  }
  function exitToAustralia() {
    setEnteredState(null);
    setHover(null);
    flyTo(zoomIdentity, EXIT_MS);
  }

  const layerStatus = suburbLayerStatus(focusedState, !!suburb, suburbFetching || topoFetching);
  const focusedName = focusedState ? STATE_NAMES[focusedState] ?? focusedState : "";

  return (
    <>
      <svg
        ref={svgRef} width={width} height={height} role="group"
        aria-label="Zoomable map of Australian house prices — click or zoom into a state to reveal its suburbs"
        style={{ touchAction: "pan-y", display: "block", cursor: detail === "suburb" ? "default" : "pointer" }}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <pattern id="zoom-nodata" width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width={6} height={6} style={{ fill: "hsl(var(--muted))" }} />
            <line x1={0} y1={0} x2={0} y2={6} strokeWidth={1} style={{ stroke: STROKE }} />
          </pattern>
        </defs>
        <g ref={gRef}>
          {/* National states layer — dims out as you enter a state */}
          <g style={{ opacity: detail === "suburb" ? 0.12 : 1, transition: reduceMotion() ? undefined : "opacity 500ms ease", pointerEvents: detail === "suburb" ? "none" : undefined }}>
            {stateFeatures.map((f) => {
              const state = STE_CODE_TO_STATE[String(f.id)];
              const v = state ? stateStats.get(state)?.median ?? null : null;
              return (
                <path
                  key={String(f.id)} d={path(f as never) ?? ""}
                  fill={featureFill(v && v > 0 ? v : null, (x) => stateScale(x))}
                  style={{ stroke: STROKE, strokeWidth: 0.6, vectorEffect: "non-scaling-stroke" }}
                  onClick={() => enterState(String(f.id))}
                  onPointerMove={(e) => {
                    if (detail === "suburb" || !state) return;
                    setHover({ kind: "state", state, x: e.clientX, y: e.clientY });
                  }}
                />
              );
            })}
          </g>

          {/* Focused state's suburb layer — viewport-culled, only in suburb detail */}
          {detail === "suburb" && suburb ? (
            <g>
              {visibleSuburbs.map((bf) => {
                const v = suburb.priceById.get(bf.id);
                return (
                  <path
                    key={bf.id} d={bf.d}
                    fill={featureFill(v, (x) => suburb.scale(x))}
                    style={{ stroke: STROKE, strokeWidth: 0.4, vectorEffect: "non-scaling-stroke", cursor: "pointer" }}
                    onPointerMove={(e) => setHover({ kind: "suburb", name: suburb.nameById.get(bf.id) ?? bf.id, price: v ?? 0, x: e.clientX, y: e.clientY })}
                    onClick={() => {
                      const s = suburb.byCode.get(bf.id);
                      if (s && focusedState) router.push(suburbHref(focusedState, { salName: s.salName, salCode: s.salCode, postcode: s.postcode }));
                    }}
                  />
                );
              })}
            </g>
          ) : null}
        </g>
      </svg>

      {/* Back-to-Australia control */}
      {detail === "suburb" ? (
        <button
          type="button" onClick={exitToAustralia}
          className="absolute left-2 top-2 z-20 flex items-center gap-1.5 rounded-md border border-border bg-card/90 px-2.5 py-1.5 text-xs font-medium text-foreground shadow-sm backdrop-blur transition-colors hover:bg-muted"
        >
          ‹ Australia
          {focusedName ? <span className="text-muted-foreground">· {focusedName} suburbs</span> : null}
        </button>
      ) : null}

      {/* Legend */}
      {detail === "suburb" && suburb && suburb.max > 1 ? (
        <div className="absolute bottom-2 left-2 z-10">
          <MapLegend colorScale={(v) => suburb.scale(v)} min={suburb.min} max={suburb.max} label={`${focusedName} median house price`} />
        </div>
      ) : null}

      {/* Suburb layer loading / error affordance while drilled into a state */}
      {focusedState && layerStatus === "loading" ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <div className="rounded-md border border-border bg-card/90 px-3 py-1.5 text-xs text-muted-foreground shadow-sm backdrop-blur">
            Loading {focusedName} suburbs…
          </div>
        </div>
      ) : focusedState && layerStatus === "error" ? (
        <div className="absolute inset-0 z-10 flex items-center justify-center">
          <div className="flex items-center gap-2 rounded-md border border-border bg-card/90 px-3 py-1.5 text-xs text-muted-foreground shadow-sm backdrop-blur">
            <span>Couldn’t load {focusedName} suburbs.</span>
            <button
              type="button"
              onClick={() => { void refetchSuburbs(); void refetchTopo(); }}
              className="font-medium text-foreground underline underline-offset-2 hover:no-underline"
            >
              Retry
            </button>
          </div>
        </div>
      ) : null}

      {/* Hover: rich state card (national) or suburb tooltip (suburb detail) */}
      {hover?.kind === "state" ? (
        <StateHoverCard name={STATE_NAMES[hover.state] ?? hover.state} stat={stateStats.get(hover.state)} x={hover.x} y={hover.y} />
      ) : hover?.kind === "suburb" ? (
        <div
          className="pointer-events-none fixed z-50 rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md"
          style={{ left: hover.x + 12, top: hover.y + 12 }}
        >
          <span className="font-medium capitalize">{hover.name.toLowerCase()}</span>
          {hover.price > 0 ? <span className="ml-1.5 font-mono tabular-nums text-muted-foreground">{fmtPriceShort(hover.price)}</span> : <span className="ml-1.5 text-muted-foreground">no price</span>}
        </div>
      ) : null}

      {/* Hint */}
      {detail === "national" ? (
        <div className="pointer-events-none absolute bottom-2 right-2 z-10 rounded-md bg-card/80 px-2 py-1 text-[11px] text-muted-foreground backdrop-blur">
          Scroll or click a state to zoom in
        </div>
      ) : null}
    </>
  );
}

/** Rich hover card for the national state layer. */
function StateHoverCard({ name, stat, x, y }: { name: string; stat: StateStat | undefined; x: number; y: number }) {
  return (
    <div
      className="pointer-events-none fixed z-50 min-w-[9rem] rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md"
      style={{ left: x + 12, top: y + 12 }}
    >
      <div className="font-medium">{name}</div>
      {stat ? (
        <>
          <div className="mt-0.5 flex items-baseline justify-between gap-3">
            <span className="text-muted-foreground">{stat.capital.replace("Greater ", "")} median</span>
            <span className="font-mono tabular-nums">{fmtPriceShort(stat.median)}</span>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-muted-foreground">Year</span>
            <span className={`font-mono tabular-nums ${stat.yoyPct >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
              {stat.yoyPct >= 0 ? "+" : ""}{stat.yoyPct.toFixed(1)}%
            </span>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-muted-foreground">Quarter</span>
            <span className="font-mono tabular-nums text-muted-foreground">{stat.qoqPct >= 0 ? "+" : ""}{stat.qoqPct.toFixed(1)}%</span>
          </div>
        </>
      ) : (
        <div className="mt-0.5 text-muted-foreground">no data</div>
      )}
    </div>
  );
}
