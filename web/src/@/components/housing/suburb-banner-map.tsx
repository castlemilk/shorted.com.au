"use client";

import { useMemo } from "react";
import { geoBounds, geoCentroid, geoMercator, geoPath } from "d3-geo";
import { feature } from "topojson-client";
import type { GeometryCollection } from "topojson-specification";
import type { Feature, Geometry } from "geojson";
import { useTopojson } from "./use-topojson";

const SIZE = 200;
const PAD = 6;
// Dense inner-city suburbs can pull dozens of neighbours into a padded bbox —
// cap the render so the thumbnail (~200x200 svg units, ~40-52px on screen)
// stays cheap and legible.
const MAX_NEIGHBOURS = 40;

/**
 * Tiny static locator for the suburb banner: the target suburb filled with
 * the theme accent, nearby suburbs rendered as faint context. No zoom/pan —
 * this is a thumbnail, not the interactive ChoroplethMap — just a single
 * fitExtent projection over the target + its in-view neighbours.
 */
export function SuburbBannerMap({ stateCode, salCode }: { stateCode: string; salCode: string }) {
  const { data: topo } = useTopojson(stateCode ? `/geo/suburbs/${stateCode}.topojson` : null);

  const model = useMemo(() => {
    if (!topo) return null;
    const objectName = Object.keys(topo.objects)[0];
    if (!objectName) return null;
    const obj = topo.objects[objectName] as GeometryCollection;
    // build-boundaries.mjs sets `this.id = SAL_CODE21`, so feature ids match
    // salCode directly — no need to reach into (any-typed) properties.
    const fc = feature(topo, obj) as unknown as { features: Feature<Geometry>[] };
    const target = fc.features.find((f) => String(f.id) === salCode);
    if (!target) return null;

    // In-view neighbours: a bbox padded around the target's own bounds,
    // filtered by centroid — cheap and good enough for a thumbnail.
    const [[tx0, ty0], [tx1, ty1]] = geoBounds(target as never);
    const padX = Math.max(tx1 - tx0, 0.02) * 3;
    const padY = Math.max(ty1 - ty0, 0.02) * 3;
    const bbox: [number, number, number, number] = [tx0 - padX, ty0 - padY, tx1 + padX, ty1 + padY];
    let inView = fc.features.filter((f) => {
      const c = geoCentroid(f as never);
      return c[0] >= bbox[0] && c[0] <= bbox[2] && c[1] >= bbox[1] && c[1] <= bbox[3];
    });
    if (!inView.includes(target)) inView.push(target);

    if (inView.length > MAX_NEIGHBOURS) {
      const cx = (tx0 + tx1) / 2, cy = (ty0 + ty1) / 2;
      inView = inView
        .map((f) => {
          const c = geoCentroid(f as never);
          const dx = c[0] - cx, dy = c[1] - cy;
          return { f, d: dx * dx + dy * dy };
        })
        .sort((a, b) => a.d - b.d)
        .slice(0, MAX_NEIGHBOURS)
        .map((x) => x.f);
      if (!inView.includes(target)) inView.push(target);
    }

    const projection = geoMercator().fitExtent(
      [[PAD, PAD], [SIZE - PAD, SIZE - PAD]],
      { type: "FeatureCollection", features: inView } as never,
    );
    const path = geoPath(projection);
    const targetPath = path(target) ?? "";
    if (!targetPath) return null;
    const neighbourPaths = inView
      .filter((f) => f !== target)
      .map((f) => ({ id: String(f.id), d: path(f) ?? "" }))
      .filter((n) => n.d);

    return { targetPath, neighbourPaths };
  }, [topo, salCode]);

  if (!model) return null;

  return (
    <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="h-full w-full" role="img" aria-label="Suburb location">
      {model.neighbourPaths.map((n) => (
        <path
          key={n.id}
          d={n.d}
          fill="none"
          stroke="currentColor"
          strokeOpacity={0.18}
          strokeWidth={1}
          className="text-muted-foreground"
          vectorEffect="non-scaling-stroke"
        />
      ))}
      <path
        d={model.targetPath}
        stroke="currentColor"
        strokeOpacity={0.7}
        strokeWidth={1.5}
        className="fill-primary text-primary"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
