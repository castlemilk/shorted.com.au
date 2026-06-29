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

const MAX_SCALE = 14;

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export interface ChoroplethMapProps {
  topology: Topology;
  objectName: string;
  /** keyed by feature id (string) → metric value, or null for "no data". */
  valueById: Map<string, number | null>;
  /** id → display name for accessibility / hover routing. */
  nameById?: Map<string, string>;
  colorScale: (v: number) => string;
  selectedId?: string;
  /** externally-driven hover highlight (e.g. from a sibling list) */
  hoveredId?: string;
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
  /** Optional legend node rendered as a bottom-left overlay. */
  legend?: ReactNode;
}

export function ChoroplethMap(props: ChoroplethMapProps) {
  return (
    <div className="relative" style={{ width: "100%", height: props.height ?? 460 }}>
      <ParentSize>{({ width, height }) =>
        width > 0 ? <ChoroplethInner {...props} width={width} height={height} /> : null
      }</ParentSize>
    </div>
  );
}

function ChoroplethInner({
  topology, objectName, valueById, nameById, colorScale, selectedId, hoveredId: hoveredIdProp,
  onFeatureClick, onFeatureHover, width, height, ariaLabel,
  fitToData, fitToId, interactive = true, legend,
}: ChoroplethMapProps & { width: number; height: number }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const gRef = useRef<SVGGElement>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const initialTransformRef = useRef(zoomIdentity);
  const [localHover, setLocalHover] = useState<string | null>(null);
  const hoveredId = hoveredIdProp ?? localHover ?? undefined;

  const { features, pathFor, initialTransform, byId } = useMemo(() => {
    const obj = topology.objects[objectName] as GeometryCollection;
    const fc = feature(topology, obj) as unknown as { features: Feature<Geometry>[] };
    const projection = geoMercator().fitSize([width, height], {
      type: "FeatureCollection", features: fc.features,
    } as never);
    const path = geoPath(projection);
    const idMap = new Map<string, Feature<Geometry>>();
    for (const f of fc.features) idMap.set(String(f.id), f);

    // Compute an initial zoom transform that frames the signal.
    let transform = zoomIdentity;
    const fitBoundsOf = (geo: unknown) => {
      const [[x0, y0], [x1, y1]] = path.bounds(geo as never);
      const bw = x1 - x0, bh = y1 - y0;
      if (!(bw > 0) || !(bh > 0)) return null;
      const scale = Math.min(MAX_SCALE, Math.max(1, 0.9 / Math.max(bw / width, bh / height)));
      const tx = width / 2 - scale * (x0 + x1) / 2;
      const ty = height / 2 - scale * (y0 + y1) / 2;
      return zoomIdentity.translate(tx, ty).scale(scale);
    };
    if (fitToId && idMap.has(fitToId)) {
      transform = fitBoundsOf(idMap.get(fitToId)) ?? transform;
    } else if (fitToData) {
      const dataFeatures = fc.features.filter((f) => {
        const v = valueById.get(String(f.id));
        return v !== null && v !== undefined;
      });
      if (dataFeatures.length) {
        transform = fitBoundsOf({ type: "FeatureCollection", features: dataFeatures }) ?? transform;
      }
    }
    return {
      features: fc.features,
      byId: idMap,
      pathFor: (f: Feature<Geometry>) => path(f) ?? "",
      initialTransform: transform,
    };
  }, [topology, objectName, width, height, fitToData, fitToId, valueById]);

  initialTransformRef.current = initialTransform;

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
    const selected = id === selectedId;
    const hovered = id === hoveredId;
    const emphasized = selected || hovered;
    return (
      <path
        key={opts.overlay ? `o-${id}` : id}
        d={pathFor(f)}
        fill={opts.overlay ? "none" : featureFill(v, colorScale)}
        strokeWidth={selected ? 1.6 : hovered ? 1.2 : 0.4}
        style={{
          cursor: interactive && onFeatureClick ? "pointer" : "default",
          stroke: emphasized ? "hsl(var(--foreground))" : "hsl(var(--border))",
          pointerEvents: opts.overlay ? "none" : undefined,
          transition: prefersReducedMotion() ? undefined : "stroke-width 120ms ease",
        }}
        tabIndex={interactive && onFeatureClick && v != null ? 0 : -1}
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

  // overlay the emphasized features on top so their thicker stroke isn't clipped
  const emphasizedIds = [hoveredId, selectedId].filter(Boolean) as string[];

  return (
    <>
      <svg
        ref={svgRef} width={width} height={height}
        role={interactive ? "group" : "img"} aria-label={ariaLabel}
        style={{ touchAction: interactive ? "pan-y" : "none", display: "block" }}
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
          <ZoomBtn label="Zoom in" onClick={() => zoomBy(1.6)}>+</ZoomBtn>
          <ZoomBtn label="Zoom out" onClick={() => zoomBy(0.625)}>−</ZoomBtn>
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
