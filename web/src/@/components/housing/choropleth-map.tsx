"use client";

import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { geoMercator, geoPath } from "d3-geo";
import { zoom as d3zoom, zoomIdentity, type D3ZoomEvent, type ZoomBehavior } from "d3-zoom";
import { select } from "d3-selection";
import { feature } from "topojson-client";
import type { Topology, GeometryCollection } from "topojson-specification";
import type { Feature, Geometry } from "geojson";
import { gestureCss, gestureIsIdentity } from "@/lib/housing/map-gesture";
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

/**
 * A second visual layer drawn ABOVE the choropleth and below the emphasis
 * strokes: translucent fill + a hairline stroke in the layer's own hue, so it
 * stays legible over any colour ramp. It shares the zoom transform and takes no
 * pointer events — hovering a suburb under an overlay still hits the suburb.
 * Solid fills rather than SVG patterns on purpose: a userSpaceOnUse hatch is
 * scaled by the d3-zoom transform and turns into 300px stripes at 48×.
 */
export interface OverlayLayer {
  key: string;
  topology: Topology;
  color: string;
  /** default OVERLAY_FILL_OPACITY */
  opacity?: number;
}

const DEFAULT_OVERLAY_OPACITY = 0.38;

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
  /** Hazard/context layers drawn above the choropleth (see OverlayLayer). */
  overlays?: OverlayLayer[];
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
  fitToData, fitToId, interactive = true, legend, overlays,
}: ChoroplethMapProps & { width: number; height: number }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const gRef = useRef<SVGGElement>(null);
  // Two maps on one page (explorer + locator) must not share clip ids.
  const clipId = useId().replace(/:/g, "");
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const initialTransformRef = useRef(zoomIdentity);
  const [localHover, setLocalHover] = useState<string | null>(null);
  const hoveredId = hoveredIdProp ?? localHover ?? undefined;

  // Geometry + framing — deliberately independent of the per-metric colour
  // inputs (valueById/categoryById) so toggling the highlight metric doesn't
  // recompute the projection or reset the zoom. `fitData` is the stable set the
  // overview frames to (the priced cluster), falling back to valueById.
  const fitData = fitValueById ?? valueById;
  const { features, pathById, pathForGeo, initialTransform, byId, focusTransformFor } = useMemo(() => {
    const obj = topology.objects[objectName] as GeometryCollection;
    const fc = feature(topology, obj) as unknown as { features: Feature<Geometry>[] };
    const projection = geoMercator().fitSize([width, height], {
      type: "FeatureCollection", features: fc.features,
    } as never);
    const path = geoPath(projection);
    const idMap = new Map<string, Feature<Geometry>>();
    const dMap = new Map<string, string>();
    for (const f of fc.features) {
      idMap.set(String(f.id), f);
      dMap.set(String(f.id), path(f) ?? "");
    }

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
      pathById: dMap,
      pathForGeo: (geo: Geometry) => path(geo as never) ?? "",
      initialTransform: transform,
      focusTransformFor: (id: string) => {
        const f = idMap.get(id);
        return f ? fitBoundsOf(f, FOCUS_PADDING, FOCUS_MAX_SCALE) : null;
      },
    };
  }, [topology, objectName, width, height, fitToData, fitToId, fitData]);

  // Overlay geometry is projected with the SAME projection as the suburbs, so
  // the two register exactly; a layer is one `<path>` per feature, usually one.
  const overlayPaths = useMemo(() => (overlays ?? []).map((layer) => {
    const objectName = Object.keys(layer.topology.objects)[0];
    if (!objectName) return { key: layer.key, color: layer.color, opacity: layer.opacity, d: [] as string[] };
    const fc = feature(layer.topology, layer.topology.objects[objectName] as GeometryCollection) as unknown as {
      features: Feature<Geometry>[];
    };
    return {
      key: layer.key, color: layer.color, opacity: layer.opacity,
      d: fc.features.map((f) => pathForGeo(f.geometry)).filter(Boolean),
    };
  }), [overlays, pathForGeo]);

  initialTransformRef.current = initialTransform;
  const focusTransformForRef = useRef(focusTransformFor);
  focusTransformForRef.current = focusTransformFor;

  // d3-zoom + pan, with the computed initial framing.
  //
  // Smoothness: during a gesture the live transform is applied as a CSS
  // transform on the SVG (GPU-composited: the raster is scaled, not redrawn);
  // the exact `<g transform>` is committed only on "end", so the browser
  // re-rasterises the 4,500 suburb paths once per gesture rather than once per
  // frame. See lib/housing/map-gesture.ts for the maths and the measurement.
  const committedRef = useRef(zoomIdentity);
  useEffect(() => {
    if (!interactive || !svgRef.current || !gRef.current) return;
    const g = select(gRef.current);
    const svg = select(svgRef.current);
    const svgEl = svgRef.current;
    const commit = (t: typeof zoomIdentity) => {
      committedRef.current = t;
      g.attr("transform", t.toString());
      svgEl.style.transform = "";
    };
    const zoomBehavior = d3zoom<SVGSVGElement, unknown>()
      .scaleExtent([1, MAX_SCALE])
      .on("start", (e: D3ZoomEvent<SVGSVGElement, unknown>) => {
        // A wheel gesture can start before the previous one's "end" committed.
        if (svgEl.style.transform) commit(e.transform);
      })
      .on("zoom", (e: D3ZoomEvent<SVGSVGElement, unknown>) => {
        if (gestureIsIdentity(committedRef.current, e.transform)) { svgEl.style.transform = ""; return; }
        svgEl.style.transform = gestureCss(committedRef.current, e.transform);
      })
      .on("end", (e: D3ZoomEvent<SVGSVGElement, unknown>) => commit(e.transform));
    zoomRef.current = zoomBehavior;
    svg.call(zoomBehavior);
    svg.on("dblclick.zoom", null);
    svgEl.style.transformOrigin = "0 0";
    svgEl.style.willChange = "transform";
    // apply initial framing without animation
    zoomBehavior.transform(svg, initialTransformRef.current);
    commit(initialTransformRef.current);
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

  // Stable handlers: the memoised paths must not see a new callback on every
  // parent render (the tooltip position updates on every pointer move), or the
  // memo buys nothing.
  const onClickRef = useRef(onFeatureClick); onClickRef.current = onFeatureClick;
  const onHoverRef = useRef(onFeatureHover); onHoverRef.current = onFeatureHover;
  const handleClick = useCallback((id: string) => onClickRef.current?.(id), []);
  const handleHover = useCallback((id: string | null, evt?: React.PointerEvent) => {
    setLocalHover(id);
    onHoverRef.current?.(id, evt);
  }, []);
  const clickable = interactive && !!onFeatureClick;

  // No-data suburbs get a SOLID muted fill; the hatch is painted once over all
  // of them through a single clip path (below). A pattern fill per path made
  // the browser instantiate the pattern 4,500 times on every repaint — the
  // default NSW view (12 priced suburbs) measured p95 hover 200 ms and wheel
  // zoom 217 ms; a solid fill measured 33 ms and 17 ms. Same look, one paint.
  const NO_DATA_FILL = "hsl(var(--muted))";
  const fillFor = (id: string): { fill: string; hasData: boolean } => {
    if (categoryById) {
      const cat = categoryById.get(id);
      const c = cat != null ? categoryColor?.(cat) : undefined;
      return { fill: c ?? NO_DATA_FILL, hasData: cat != null && c != null };
    }
    const v = valueById.get(id);
    return v == null ? { fill: NO_DATA_FILL, hasData: false } : { fill: colorScale(v), hasData: true };
  };
  const noDataClip = useMemo(() => {
    const parts: string[] = [];
    for (const f of features) {
      const id = String(f.id);
      if (!fillFor(id).hasData) parts.push(pathById.get(id) ?? "");
    }
    return parts.join(" ");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fillFor is derived from these
  }, [features, pathById, valueById, categoryById, categoryColor]);

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
          {noDataClip ? (
            <clipPath id={`${clipId}-nodata`}>
              <path d={noDataClip} />
            </clipPath>
          ) : null}
        </defs>
        <g ref={gRef}>
          {features.map((f) => {
            const id = String(f.id);
            const { fill, hasData } = fillFor(id);
            return (
              <SuburbPath
                key={id} id={id} d={pathById.get(id) ?? ""} fill={fill} hasData={hasData}
                name={nameById?.get(id) ?? id}
                selected={id === selectedId} hovered={id === hoveredId}
                interactive={interactive} clickable={clickable}
                onClick={handleClick} onHover={handleHover}
              />
            );
          })}
          {noDataClip ? (
            <rect
              x={0} y={0} width={width} height={height}
              fill="url(#nodata-hatch)" clipPath={`url(#${clipId}-nodata)`}
              style={{ pointerEvents: "none" }}
            />
          ) : null}
          {overlayPaths.map((layer) => (
            <OverlayLayerPaths key={`overlay-${layer.key}`} layerKey={layer.key} color={layer.color} opacity={layer.opacity} d={layer.d} />
          ))}
          {emphasizedIds
            .filter((id) => byId.has(id))
            .map((id) => (
              <SuburbPath
                key={`o-${id}`} id={id} d={pathById.get(id) ?? ""} fill="none" hasData
                name={nameById?.get(id) ?? id} selected={id === selectedId} hovered={id === hoveredId}
                interactive={false} clickable={false} overlay
              />
            ))}
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

/**
 * One suburb. Memoised on primitive props so a hover re-renders the two paths
 * whose emphasis changed, not the whole state (measured 2026-09-09: p95 hover
 * frame 233 ms for NSW before, with every path re-rendered per pointer move).
 */
const SuburbPath = memo(function SuburbPath({
  id, d, fill, hasData, name, selected, hovered, interactive, clickable, overlay = false, onClick, onHover,
}: {
  id: string; d: string; fill: string; hasData: boolean; name: string;
  selected: boolean; hovered: boolean; interactive: boolean; clickable: boolean; overlay?: boolean;
  onClick?: (id: string) => void;
  onHover?: (id: string | null, evt?: React.PointerEvent) => void;
}) {
  const emphasized = selected || hovered;
  return (
    <path
      d={d}
      fill={fill}
      strokeWidth={selected ? 1.6 : hovered ? 1.2 : 0.4}
      style={{
        cursor: clickable ? "pointer" : "default",
        stroke: emphasized ? "hsl(var(--foreground))" : "hsl(var(--border))",
        // strokeWidth is in user-space units; the group is d3-zoomed up to 48×, so
        // a 1.6u emphasis stroke renders ~22px wide and swallows small suburbs into
        // a solid dark blob. Pin stroke to screen px so it stays a crisp outline.
        vectorEffect: "non-scaling-stroke",
        pointerEvents: overlay ? "none" : undefined,
        // SVG focus outlines render as the path's rectangular bbox ("square") —
        // suppress it; keyboard focus is shown via the stroke highlight (onFocus).
        outline: "none",
      }}
      tabIndex={clickable && hasData ? 0 : -1}
      role={clickable ? "button" : undefined}
      aria-label={name}
      onClick={interactive ? () => onClick?.(id) : undefined}
      onKeyDown={interactive ? (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick?.(id); }
      } : undefined}
      onFocus={interactive ? () => onHover?.(id) : undefined}
      onBlur={interactive ? () => onHover?.(null) : undefined}
      onPointerMove={interactive ? (e) => onHover?.(id, e) : undefined}
      onPointerLeave={interactive ? () => onHover?.(null) : undefined}
    />
  );
});

/** One overlay layer; memoised so a hover never re-serialises its geometry. */
const OverlayLayerPaths = memo(function OverlayLayerPaths({
  layerKey, color, opacity, d,
}: { layerKey: string; color: string; opacity?: number; d: string[] }) {
  return (
    <g data-overlay={layerKey} style={{ pointerEvents: "none" }}>
      {d.map((path, i) => (
        <path
          key={i} d={path}
          fill={color} fillOpacity={opacity ?? DEFAULT_OVERLAY_OPACITY}
          stroke={color} strokeWidth={0.6} strokeOpacity={Math.min(1, (opacity ?? DEFAULT_OVERLAY_OPACITY) + 0.5)}
          style={{ vectorEffect: "non-scaling-stroke" }}
        />
      ))}
    </g>
  );
});

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
