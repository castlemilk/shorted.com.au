"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { geoMercator, geoPath } from "d3-geo";
import { zoom as d3zoom, zoomIdentity, type D3ZoomEvent, type ZoomBehavior } from "d3-zoom";
import { select } from "d3-selection";
import { feature } from "topojson-client";
import type { Topology, GeometryCollection } from "topojson-specification";
import type { Feature, Geometry } from "geojson";
import { ParentSize } from "@visx/responsive";

/** Fill for a feature: hatch sentinel when no data, else the colour scale. */
export function featureFill(
  value: number | null | undefined,
  colorScale: (v: number) => string,
): string {
  if (value === null || value === undefined) return "url(#nodata-hatch)";
  return colorScale(value);
}

// Deep enough to read an individual suburb's shape; non-scaling-stroke keeps
// borders crisp at the ceiling.
const MAX_SCALE = 48;
// A selected suburb frames to ~40% of the viewport so its neighbours stay
// visible for context (a single-suburb fill of 0.9 feels disorientating).
const FOCUS_PADDING = 0.4;
const FOCUS_MAX_SCALE = 30;

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export interface ChoroplethMapProps {
  topology: Topology;
  objectName: string;
  /** keyed by feature id (string) → metric value, or null for "no data". */
  valueById: Map<string, number | null>;
  /** continuous colour scale for valueById. */
  colorScale: (v: number) => string;
  /** categorical mode: feature id → category label (null = no data). When set,
   *  this drives the fill instead of valueById/colorScale. */
  categoryById?: Map<string, string | null>;
  /** colour for a category label (categorical mode). */
  categoryColor?: (category: string) => string;
  /** id → display name for accessibility / hover routing. */
  nameById?: Map<string, string>;
  /** Stable values used ONLY to frame the fitToData view — kept independent of
   *  the toggled highlight metric so switching metrics never resets the zoom. */
  fitValueById?: Map<string, number | null>;
  selectedId?: string;
  /** externally-driven hover highlight (e.g. from a sibling list) */
  hoveredId?: string;
  /** smoothly zoom+pan the map to frame this feature; returns to the overview
   *  when cleared. */
  focusId?: string;
  onFeatureClick?: (id: string) => void;
  onFeatureHover?: (id: string | null, evt?: React.PointerEvent) => void;
  height?: number;
  ariaLabel: string;
  /** Initial view fits the bbox of data-bearing features (the priced cluster). */
  fitToData?: boolean;
  /** Initial view fits a single feature (locator inset). */
  fitToId?: string;
  /** false = static inset: no zoom, no controls, no pointer interaction. */
  interactive?: boolean;
  /** Fill the parent's height (flex) instead of a fixed px height. */
  fill?: boolean;
  /** Optional legend node rendered as a bottom-left overlay. */
  legend?: ReactNode;
}

export function ChoroplethMap(props: ChoroplethMapProps) {
  return (
    <div
      className={props.fill ? "relative h-full w-full min-h-[460px]" : "relative"}
      style={props.fill ? undefined : { width: "100%", height: props.height ?? 460 }}
    >
      <ParentSize>{({ width, height }) =>
        width > 0 && height > 0 ? <ChoroplethInner {...props} width={width} height={height} /> : null
      }</ParentSize>
    </div>
  );
}

function ChoroplethInner({
  topology, objectName, valueById, categoryById, categoryColor, nameById, colorScale,
  fitValueById, selectedId, hoveredId: hoveredIdProp, focusId,
  onFeatureClick, onFeatureHover, width, height, ariaLabel,
  fitToData, fitToId, interactive = true, legend,
}: ChoroplethMapProps & { width: number; height: number }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const gRef = useRef<SVGGElement>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const initialTransformRef = useRef(zoomIdentity);
  const [localHover, setLocalHover] = useState<string | null>(null);
  const hoveredId = hoveredIdProp ?? localHover ?? undefined;

  // Geometry + framing — deliberately independent of the per-metric colour
  // inputs (valueById/categoryById) so toggling the highlight metric doesn't
  // recompute the projection or reset the zoom. `fitData` is the stable set the
  // overview frames to (the priced cluster), falling back to valueById.
  const fitData = fitValueById ?? valueById;
  const { features, pathFor, initialTransform, byId, focusTransformFor } = useMemo(() => {
    const obj = topology.objects[objectName] as GeometryCollection;
    const fc = feature(topology, obj) as unknown as { features: Feature<Geometry>[] };
    const projection = geoMercator().fitSize([width, height], {
      type: "FeatureCollection", features: fc.features,
    } as never);
    const path = geoPath(projection);
    const idMap = new Map<string, Feature<Geometry>>();
    for (const f of fc.features) idMap.set(String(f.id), f);

    const fitBoundsOf = (geo: unknown, padding: number, cap: number) => {
      const [[x0, y0], [x1, y1]] = path.bounds(geo as never);
      const bw = x1 - x0, bh = y1 - y0;
      if (!(bw > 0) || !(bh > 0)) return null;
      const scale = Math.min(cap, Math.max(1, padding / Math.max(bw / width, bh / height)));
      const tx = width / 2 - scale * (x0 + x1) / 2;
      const ty = height / 2 - scale * (y0 + y1) / 2;
      return zoomIdentity.translate(tx, ty).scale(scale);
    };

    // Compute an initial zoom transform that frames the signal.
    let transform = zoomIdentity;
    if (fitToId && idMap.has(fitToId)) {
      transform = fitBoundsOf(idMap.get(fitToId), 0.9, MAX_SCALE) ?? transform;
    } else if (fitToData) {
      const dataFeatures = fc.features.filter((f) => {
        const v = fitData.get(String(f.id));
        return v !== null && v !== undefined;
      });
      if (dataFeatures.length) {
        transform = fitBoundsOf({ type: "FeatureCollection", features: dataFeatures }, 0.9, MAX_SCALE) ?? transform;
      }
    }
    return {
      features: fc.features,
      byId: idMap,
      pathFor: (f: Feature<Geometry>) => path(f) ?? "",
      initialTransform: transform,
      focusTransformFor: (id: string) => {
        const f = idMap.get(id);
        return f ? fitBoundsOf(f, FOCUS_PADDING, FOCUS_MAX_SCALE) : null;
      },
    };
  }, [topology, objectName, width, height, fitToData, fitToId, fitData]);

  initialTransformRef.current = initialTransform;
  const focusTransformForRef = useRef(focusTransformFor);
  focusTransformForRef.current = focusTransformFor;

  // d3-zoom + pan, with the computed initial framing.
  useEffect(() => {
    if (!interactive || !svgRef.current || !gRef.current) return;
    const g = select(gRef.current);
    const svg = select(svgRef.current);
    const zoomBehavior = d3zoom<SVGSVGElement, unknown>()
      .scaleExtent([1, MAX_SCALE])
      .on("zoom", (e: D3ZoomEvent<SVGSVGElement, unknown>) =>
        g.attr("transform", e.transform.toString()));
    zoomRef.current = zoomBehavior;
    svg.call(zoomBehavior);
    svg.on("dblclick.zoom", null);
    // apply initial framing without animation
    zoomBehavior.transform(svg, initialTransformRef.current);
    return () => { svg.on(".zoom", null); zoomRef.current = null; };
  }, [interactive, width, height, initialTransform]);

  // Selected suburb → smoothly zoom to frame it; deselect → ease back to overview.
  const prevFocusRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!interactive || !zoomRef.current || !svgRef.current) return;
    const svg = select(svgRef.current);
    const dur = prefersReducedMotion() ? 0 : 600;
    if (focusId) {
      const t = focusTransformForRef.current(focusId);
      if (t) zoomRef.current.transform(svg.transition().duration(dur), t);
    } else if (prevFocusRef.current) {
      zoomRef.current.transform(svg.transition().duration(dur), initialTransformRef.current);
    }
    prevFocusRef.current = focusId;
  }, [focusId, interactive]);

  // Static inset (locator): apply the fit transform directly to the group.
  useEffect(() => {
    if (interactive || !gRef.current) return;
    select(gRef.current).attr("transform", initialTransform.toString());
  }, [interactive, initialTransform]);

  const zoomBy = (k: number) => {
    if (!zoomRef.current || !svgRef.current) return;
    const dur = prefersReducedMotion() ? 0 : 250;
    zoomRef.current.scaleBy(select(svgRef.current).transition().duration(dur), k);
  };
  const resetZoom = () => {
    if (!zoomRef.current || !svgRef.current) return;
    const dur = prefersReducedMotion() ? 0 : 350;
    zoomRef.current.transform(
      select(svgRef.current).transition().duration(dur), initialTransformRef.current);
  };

  const setHover = (id: string | null, evt?: React.PointerEvent) => {
    setLocalHover(id);
    onFeatureHover?.(id, evt);
  };

  const renderPath = (f: Feature<Geometry>, opts: { overlay?: boolean }) => {
    const id = String(f.id);
    const v = valueById.get(id);
    const cat = categoryById?.get(id);
    const hasData = categoryById ? cat != null : v != null;
    const baseFill = categoryById
      ? (cat != null ? (categoryColor?.(cat) ?? "url(#nodata-hatch)") : "url(#nodata-hatch)")
      : featureFill(v, colorScale);
    const selected = id === selectedId;
    const hovered = id === hoveredId;
    const emphasized = selected || hovered;
    return (
      <path
        key={opts.overlay ? `o-${id}` : id}
        d={pathFor(f)}
        fill={opts.overlay ? "none" : baseFill}
        strokeWidth={selected ? 1.6 : hovered ? 1.2 : 0.4}
        style={{
          cursor: interactive && onFeatureClick ? "pointer" : "default",
          stroke: emphasized ? "hsl(var(--foreground))" : "hsl(var(--border))",
          // strokeWidth is in user-space units; the group is d3-zoomed up to 48×, so
          // a 1.6u emphasis stroke renders ~22px wide and swallows small suburbs into
          // a solid dark blob. Pin stroke to screen px so it stays a crisp outline.
          vectorEffect: "non-scaling-stroke",
          pointerEvents: opts.overlay ? "none" : undefined,
          // SVG focus outlines render as the path's rectangular bbox ("square") —
          // suppress it; keyboard focus is shown via the stroke highlight (onFocus).
          outline: "none",
          transition: prefersReducedMotion() ? undefined : "stroke-width 120ms ease",
        }}
        tabIndex={interactive && onFeatureClick && hasData ? 0 : -1}
        role={interactive && onFeatureClick ? "button" : undefined}
        aria-label={nameById?.get(id) ?? id}
        onClick={interactive ? () => onFeatureClick?.(id) : undefined}
        onKeyDown={interactive ? (e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onFeatureClick?.(id); }
        } : undefined}
        onFocus={interactive ? () => setHover(id) : undefined}
        onBlur={interactive ? () => setHover(null) : undefined}
        onPointerMove={interactive ? (e) => setHover(id, e) : undefined}
        onPointerLeave={interactive ? () => setHover(null) : undefined}
      />
    );
  };

  // overlay the emphasized features on top so their thicker stroke isn't clipped.
  // dedupe: hoveredId often === selectedId, which would emit duplicate React keys
  // (o-<id>) and leave a stuck overlay path that doesn't clear on hover-out.
  const emphasizedIds = [...new Set([hoveredId, selectedId].filter(Boolean) as string[])];

  return (
    <>
      <svg
        ref={svgRef} width={width} height={height}
        role={interactive ? "group" : "img"} aria-label={ariaLabel}
        style={{ touchAction: interactive ? "pan-y" : "auto", display: "block" }}
      >
        <defs>
          <pattern id="nodata-hatch" width={6} height={6} patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)">
            {/* var() only resolves in CSS, and tokens are HSL triplets → hsl(var(--x)) via style */}
            <rect width={6} height={6} style={{ fill: "hsl(var(--muted))" }} />
            <line x1={0} y1={0} x2={0} y2={6} strokeWidth={1} style={{ stroke: "hsl(var(--border))" }} />
          </pattern>
        </defs>
        <g ref={gRef}>
          {features.map((f) => renderPath(f, {}))}
          {emphasizedIds
            .map((id) => byId.get(id))
            .filter((f): f is Feature<Geometry> => !!f)
            .map((f) => renderPath(f, { overlay: true }))}
        </g>
      </svg>

      {interactive && (
        <div className="absolute right-2 top-2 flex flex-col gap-1">
          <ZoomBtn label="Zoom in" onClick={() => zoomBy(2)}>+</ZoomBtn>
          <ZoomBtn label="Zoom out" onClick={() => zoomBy(0.5)}>−</ZoomBtn>
          <ZoomBtn label="Reset view" onClick={resetZoom}>
            <span className="text-[10px] leading-none">⤢</span>
          </ZoomBtn>
        </div>
      )}

      {legend ? <div className="absolute bottom-2 left-2">{legend}</div> : null}
    </>
  );
}

function ZoomBtn({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button" aria-label={label} onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-card/90 text-sm font-medium text-foreground shadow-sm backdrop-blur transition-colors hover:bg-muted"
    >
      {children}
    </button>
  );
}
