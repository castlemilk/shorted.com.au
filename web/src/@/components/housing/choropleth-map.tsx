"use client";

import { useEffect, useMemo, useRef } from "react";
import { geoMercator, geoPath } from "d3-geo";
import { zoom as d3zoom, type D3ZoomEvent } from "d3-zoom";
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

export interface ChoroplethMapProps {
  topology: Topology;
  objectName: string;
  /** keyed by feature id (string) → metric value, or null for "no data". */
  valueById: Map<string, number | null>;
  /** id → display name for accessibility / hover routing. */
  nameById?: Map<string, string>;
  colorScale: (v: number) => string;
  selectedId?: string;
  onFeatureClick?: (id: string) => void;
  onFeatureHover?: (id: string | null, evt?: React.PointerEvent) => void;
  height?: number;
  ariaLabel: string;
}

export function ChoroplethMap(props: ChoroplethMapProps) {
  return (
    <div style={{ width: "100%", height: props.height ?? 460 }}>
      <ParentSize>{({ width, height }) =>
        width > 0 ? <ChoroplethInner {...props} width={width} height={height} /> : null
      }</ParentSize>
    </div>
  );
}

function ChoroplethInner({
  topology, objectName, valueById, nameById, colorScale, selectedId,
  onFeatureClick, onFeatureHover, width, height, ariaLabel,
}: ChoroplethMapProps & { width: number; height: number }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const gRef = useRef<SVGGElement>(null);

  const { features, pathFor } = useMemo(() => {
    const obj = topology.objects[objectName] as GeometryCollection;
    const fc = feature(topology, obj) as unknown as { features: Feature<Geometry>[] };
    const projection = geoMercator().fitSize([width, height], {
      type: "FeatureCollection", features: fc.features,
    } as never);
    const path = geoPath(projection);
    return { features: fc.features, pathFor: (f: Feature<Geometry>) => path(f) ?? "" };
  }, [topology, objectName, width, height]);

  // Pinch-zoom + pan via d3-zoom (touch pinch supported natively).
  useEffect(() => {
    if (!svgRef.current || !gRef.current) return;
    const g = select(gRef.current);
    const zoomBehavior = d3zoom<SVGSVGElement, unknown>()
      .scaleExtent([1, 12])
      .on("zoom", (e: D3ZoomEvent<SVGSVGElement, unknown>) =>
        g.attr("transform", e.transform.toString()));
    const svg = select(svgRef.current);
    svg.call(zoomBehavior);
    svg.on("dblclick.zoom", null);
    return () => { svg.on(".zoom", null); };
  }, [width, height]);

  return (
    <svg ref={svgRef} width={width} height={height} role="img" aria-label={ariaLabel}
      style={{ touchAction: "none", display: "block" }}>
      <defs>
        <pattern id="nodata-hatch" width={6} height={6} patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)">
          {/* var() only resolves in CSS, and these tokens are HSL triplets → hsl(var(--x)) via style */}
          <rect width={6} height={6} style={{ fill: "hsl(var(--muted))" }} />
          <line x1={0} y1={0} x2={0} y2={6} strokeWidth={1} style={{ stroke: "hsl(var(--border))" }} />
        </pattern>
      </defs>
      <g ref={gRef}>
        {features.map((f) => {
          const id = String(f.id);
          const v = valueById.get(id);
          const selected = id === selectedId;
          return (
            <path
              key={id}
              d={pathFor(f)}
              fill={featureFill(v, colorScale)}
              strokeWidth={selected ? 1.5 : 0.4}
              style={{
                cursor: onFeatureClick ? "pointer" : "default", outline: "none",
                stroke: selected ? "hsl(var(--foreground))" : "hsl(var(--border))",
              }}
              tabIndex={onFeatureClick ? 0 : -1}
              aria-label={nameById?.get(id) ?? id}
              onClick={() => onFeatureClick?.(id)}
              onKeyDown={(e) => { if (e.key === "Enter") onFeatureClick?.(id); }}
              onPointerMove={(e) => onFeatureHover?.(id, e)}
              onPointerLeave={() => onFeatureHover?.(null)}
            />
          );
        })}
      </g>
    </svg>
  );
}
