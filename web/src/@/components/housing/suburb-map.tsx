"use client";

import { useMemo, useState } from "react";
import { ParentSize } from "@visx/responsive";
import { geoMercator } from "d3-geo";
import { Delaunay } from "d3-delaunay";
import { scaleSequentialSqrt } from "d3-scale";
import { interpolateYlOrRd } from "d3-scale-chromatic";
import { extent } from "d3-array";
import CENTROIDS_RAW from "./data/suburb-centroids.json";

const CENTROIDS = CENTROIDS_RAW as unknown as Record<string, [number, number]>;

export type MapRegion = { regionCode: string; regionName: string; value: number };

type Datum = { regionCode: string; regionName: string; value: number; lng: number; lat: number };

function fmtAUD(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${Math.round(v / 1000)}k`;
  return `$${Math.round(v)}`;
}

/**
 * A Voronoi choropleth: each suburb (positioned by its centroid) becomes a
 * colored cell, the cells clipped to the convex hull of the data so the whole
 * reads as a filled map of the populated area. Colour encodes the latest median
 * price. Click a cell to select that suburb. No bundled boundary polygons — only
 * ~50KB of centroids — so it stays light and always matches the live region set.
 */
export function SuburbMap({
  regions,
  selectedCode,
  onSelect,
}: {
  regions: MapRegion[];
  selectedCode?: string;
  onSelect: (regionCode: string) => void;
}) {
  const data: Datum[] = useMemo(
    () =>
      regions
        .map((r) => {
          const c = CENTROIDS[r.regionCode];
          return c && r.value > 0
            ? { regionCode: r.regionCode, regionName: r.regionName, value: r.value, lng: c[0], lat: c[1] }
            : null;
        })
        .filter((d): d is Datum => d !== null),
    [regions],
  );

  if (data.length < 3) {
    return (
      <div className="flex h-[300px] items-center justify-center rounded-xl border border-border bg-card text-sm text-muted-foreground">
        Not enough mapped suburbs to draw the map.
      </div>
    );
  }

  return (
    <ParentSize>
      {({ width }) => <MapInner width={width} data={data} selectedCode={selectedCode} onSelect={onSelect} />}
    </ParentSize>
  );
}

function MapInner({
  width,
  data,
  selectedCode,
  onSelect,
}: {
  width: number;
  data: Datum[];
  selectedCode?: string;
  onSelect: (regionCode: string) => void;
}) {
  const height = Math.round(Math.min(Math.max(width * 0.74, 280), 460));
  const [hover, setHover] = useState<{ d: Datum; x: number; y: number } | null>(null);

  const model = useMemo(() => {
    if (width <= 0 || height <= 0 || data.length < 3) return null;
    const proj = geoMercator().fitExtent(
      [
        [10, 10],
        [width - 10, height - 10],
      ],
      { type: "MultiPoint", coordinates: data.map((d) => [d.lng, d.lat]) },
    );
    const pts = data
      .map((d) => proj([d.lng, d.lat]))
      .map((p) => (p && Number.isFinite(p[0]) && Number.isFinite(p[1]) ? (p as [number, number]) : null));
    // bail if projection failed for any point
    if (pts.some((p) => p === null)) return null;
    const safePts = pts as [number, number][];
    const del = Delaunay.from(safePts);
    const vor = del.voronoi([0, 0, width, height]);
    const dom = extent(data, (d) => d.value) as [number, number];
    const color = scaleSequentialSqrt(interpolateYlOrRd).domain(dom);
    const hullPath =
      "M" + Array.from(del.hull).map((i) => `${safePts[i]![0]},${safePts[i]![1]}`).join("L") + "Z";
    const cells = data.map((d, i) => ({ d, path: vor.renderCell(i), x: safePts[i]![0], y: safePts[i]![1] }));
    return { cells, color, hullPath, dom };
  }, [data, width, height]);

  if (!model) return <div style={{ height }} className="w-full animate-pulse rounded bg-muted" />;

  return (
    <div className="relative">
      <svg width={width} height={height} role="img" aria-label="Median house price by suburb">
        <defs>
          <clipPath id="suburb-hull">
            <path d={model.hullPath} />
          </clipPath>
        </defs>
        <g clipPath="url(#suburb-hull)">
          {model.cells.map((c) => {
            const isSel = c.d.regionCode === selectedCode;
            const isHov = hover?.d.regionCode === c.d.regionCode;
            return (
              <path
                key={c.d.regionCode}
                d={c.path}
                fill={model.color(c.d.value)}
                fillOpacity={isSel ? 1 : isHov ? 0.92 : 0.82}
                stroke={isSel ? "var(--foreground, #111)" : "rgba(255,255,255,0.55)"}
                strokeWidth={isSel ? 1.6 : 0.4}
                className="cursor-pointer"
                onMouseEnter={() => setHover({ d: c.d, x: c.x, y: c.y })}
                onMouseLeave={() => setHover((h) => (h?.d.regionCode === c.d.regionCode ? null : h))}
                onClick={() => onSelect(c.d.regionCode)}
              />
            );
          })}
        </g>
        {/* selected marker dot */}
        {model.cells
          .filter((c) => c.d.regionCode === selectedCode)
          .map((c) => (
            <circle key="sel" cx={c.x} cy={c.y} r={3.5} fill="var(--foreground,#111)" stroke="#fff" strokeWidth={1.5} />
          ))}
      </svg>

      {hover ? (
        <div
          className="pointer-events-none absolute z-10 rounded-md border border-border bg-popover px-2 py-1 text-xs shadow-md"
          style={{ left: Math.min(hover.x + 10, width - 130), top: Math.max(hover.y - 34, 4) }}
        >
          <div className="font-medium capitalize text-foreground">{hover.d.regionName.toLowerCase()}</div>
          <div className="font-mono tabular-nums text-muted-foreground">{fmtAUD(hover.d.value)}</div>
        </div>
      ) : null}

      {/* legend */}
      <div className="mt-3 flex items-center gap-2 text-[10px] text-muted-foreground">
        <span className="font-mono tabular-nums">{fmtAUD(model.dom[0])}</span>
        <div
          className="h-2 flex-1 rounded-full"
          style={{
            background: `linear-gradient(to right, ${interpolateYlOrRd(0.05)}, ${interpolateYlOrRd(0.4)}, ${interpolateYlOrRd(0.7)}, ${interpolateYlOrRd(0.98)})`,
          }}
        />
        <span className="font-mono tabular-nums">{fmtAUD(model.dom[1])}</span>
        <span className="ml-1 whitespace-nowrap">median · {model.cells.length} suburbs</span>
      </div>
    </div>
  );
}
