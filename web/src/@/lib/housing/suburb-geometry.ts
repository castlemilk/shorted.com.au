/**
 * Pure suburb geometry — the single source of truth for the small maps a
 * suburb carries: the banner locator (the suburb among its neighbours), the
 * state locator (where the suburb sits in its state) and the boundary
 * silhouette the Open Graph card draws.
 *
 * WHY THIS IS ISOMORPHIC AND FS-FREE
 *
 * The locator used to be computed in the browser: every suburb page fetched
 * the whole state's boundary TopoJSON (336 KB gzipped for NSW, 1.3 MB
 * decoded) to draw a 200px thumbnail. This module takes already-decoded
 * GeoJSON features and returns SVG path strings, so the page can run it once
 * on the server during ISR and ship a few hundred bytes of <path> instead. The
 * node:fs loader that feeds it lives in `suburb-geometry.server.ts`.
 *
 * Bounds and centroids are computed here in plain lon/lat arithmetic rather
 * than with d3's spherical helpers: at suburb scale the difference is
 * sub-metre, and it keeps the module runnable under the test environment's
 * stubbed d3-geo (which only provides the projection + path pair).
 */
import { geoMercator, geoPath, type GeoProjection } from "d3-geo";
import type { Feature, Geometry, Position } from "geojson";

/**
 * A d3 path context that writes a compact SVG path: coordinates rounded to
 * `digits` decimals and consecutive duplicate points dropped.
 *
 * A state boundary is ~10k vertices at source resolution; projected into a
 * 320×200 locator, most of them land on the same pixel as their neighbour.
 * d3's default serialiser keeps every one at three decimals, which put a 78 KB
 * path into every suburb page (measured, Victoria). Rounding to whole pixels
 * and deduping collapses that to a few KB with no visible difference.
 */
class CompactPathContext {
  private parts: string[] = [];
  private lastX = NaN;
  private lastY = NaN;
  private readonly scale: number;

  constructor(digits: number) {
    this.scale = 10 ** digits;
  }

  private fmt(v: number): string {
    return String(Math.round(v * this.scale) / this.scale);
  }

  beginPath(): void {
    this.parts = [];
    this.lastX = NaN;
    this.lastY = NaN;
  }

  moveTo(x: number, y: number): void {
    this.lastX = x;
    this.lastY = y;
    this.parts.push(`M${this.fmt(x)},${this.fmt(y)}`);
  }

  lineTo(x: number, y: number): void {
    const fx = this.fmt(x), fy = this.fmt(y);
    if (fx === this.fmt(this.lastX) && fy === this.fmt(this.lastY)) return;
    this.lastX = x;
    this.lastY = y;
    this.parts.push(`L${fx},${fy}`);
  }

  // Never emitted for polygon features; present to satisfy the interface.
  arc(): void {
    /* no-op */
  }

  closePath(): void {
    this.parts.push("Z");
  }

  toString(): string {
    return this.parts.join("");
  }
}

/** SVG path `d` for a feature under `projection`, compacted; "" when empty. */
export function compactPath(projection: GeoProjection, feature: SuburbFeature, digits: number): string {
  const ctx = new CompactPathContext(digits);
  geoPath(projection, ctx as never)(feature as never);
  const d = ctx.toString();
  // A degenerate feature yields only "Z"s or nothing; treat both as empty.
  return /[ML]/.test(d) ? d : "";
}

export const LOCATOR_SIZE = 200;
const LOCATOR_PAD = 6;
/**
 * Dense inner-city suburbs can pull dozens of neighbours into a padded bbox —
 * cap the render so the thumbnail stays cheap and legible.
 */
export const MAX_NEIGHBOURS = 40;

export type SuburbFeature = Feature<Geometry | null>;

export interface LonLat {
  lon: number;
  lat: number;
}

export type LonLatBounds = [[number, number], [number, number]];

export interface SuburbLocatorModel {
  /** viewBox is `0 0 size size`. */
  size: number;
  /** The suburb itself. */
  targetPath: string;
  /** In-view neighbours, drawn as faint context. */
  neighbourPaths: Array<{ id: string; d: string }>;
}

export interface StateLocatorModel {
  width: number;
  height: number;
  statePath: string;
  suburbPath: string;
  /** Projected centroid of the suburb, for a marker that survives tiny polygons. */
  marker: { x: number; y: number };
}

export interface SuburbGeometryModel {
  locator: SuburbLocatorModel;
  centroid: LonLat;
  bounds: LonLatBounds;
}

function eachRing(geometry: Geometry | null | undefined, fn: (ring: Position[]) => void): void {
  // The ABS SAL set includes placeholder areas with NO geometry — "No usual
  // address (Vic.)", "Migratory - Offshore - Shipping (Vic.)" — which topojson
  // decodes as `geometry: null`. They must read as "no rings", not throw
  // half-way through a neighbour scan (which is exactly what took every
  // Victorian map down on the first render: one null in 3,076 features).
  if (!geometry) return;
  if (geometry.type === "Polygon") {
    for (const ring of geometry.coordinates) fn(ring);
  } else if (geometry.type === "MultiPolygon") {
    for (const polygon of geometry.coordinates) for (const ring of polygon) fn(ring);
  } else if (geometry.type === "GeometryCollection") {
    for (const g of geometry.geometries) eachRing(g, fn);
  }
}

/** Planar lon/lat bounding box of a (Multi)Polygon feature. */
export function featureBounds(feature: SuburbFeature): LonLatBounds | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  eachRing(feature.geometry, (ring) => {
    for (const [x, y] of ring) {
      if (x === undefined || y === undefined) continue;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  });
  if (!Number.isFinite(x0)) return null;
  return [[x0, y0], [x1, y1]];
}

/**
 * Area-weighted centroid over every ring (shoelace formula). Holes carry
 * opposite winding and subtract themselves. Degenerate (zero-area) geometry
 * falls back to the bounds centre so a point is always returned for a real
 * feature.
 */
export function featureCentroid(feature: SuburbFeature): LonLat | null {
  let area = 0, cx = 0, cy = 0;
  eachRing(feature.geometry, (ring) => {
    for (let i = 0, n = ring.length; i < n; i++) {
      const a = ring[i]!, b = ring[(i + 1) % n]!;
      const cross = a[0]! * b[1]! - b[0]! * a[1]!;
      area += cross;
      cx += (a[0]! + b[0]!) * cross;
      cy += (a[1]! + b[1]!) * cross;
    }
  });
  if (Math.abs(area) > 1e-12) {
    return { lon: cx / (3 * area), lat: cy / (3 * area) };
  }
  const b = featureBounds(feature);
  if (!b) return null;
  return { lon: (b[0][0] + b[1][0]) / 2, lat: (b[0][1] + b[1][1]) / 2 };
}

/** Find one suburb by ABS SAL code (build-boundaries.mjs sets feature.id = SAL_CODE21). */
export function findSuburbFeature(
  features: readonly SuburbFeature[],
  salCode: string,
): SuburbFeature | undefined {
  return features.find((f) => String(f.id) === salCode);
}

/**
 * The suburb among its neighbours: a bbox padded around the target's own
 * bounds, filtered by centroid — cheap and good enough for a thumbnail — capped
 * to the nearest MAX_NEIGHBOURS, then one fitExtent projection over the set.
 */
export function buildSuburbLocatorModel(
  features: readonly SuburbFeature[],
  salCode: string,
): SuburbGeometryModel | null {
  const target = findSuburbFeature(features, salCode);
  if (!target) return null;
  const bounds = featureBounds(target);
  const centroid = featureCentroid(target);
  if (!bounds || !centroid) return null;

  const [[tx0, ty0], [tx1, ty1]] = bounds;
  const padX = Math.max(tx1 - tx0, 0.02) * 3;
  const padY = Math.max(ty1 - ty0, 0.02) * 3;
  const bbox = { x0: tx0 - padX, y0: ty0 - padY, x1: tx1 + padX, y1: ty1 + padY };
  const cx = (tx0 + tx1) / 2, cy = (ty0 + ty1) / 2;

  const candidates: Array<{ f: SuburbFeature; d: number }> = [];
  for (const f of features) {
    if (f === target) continue;
    const c = featureCentroid(f);
    if (!c) continue;
    if (c.lon < bbox.x0 || c.lon > bbox.x1 || c.lat < bbox.y0 || c.lat > bbox.y1) continue;
    const dx = c.lon - cx, dy = c.lat - cy;
    candidates.push({ f, d: dx * dx + dy * dy });
  }
  candidates.sort((a, b) => a.d - b.d);
  const neighbours = candidates.slice(0, MAX_NEIGHBOURS).map((c) => c.f);
  const inView = [...neighbours, target];

  const projection = geoMercator().fitExtent(
    [[LOCATOR_PAD, LOCATOR_PAD], [LOCATOR_SIZE - LOCATOR_PAD, LOCATOR_SIZE - LOCATOR_PAD]],
    { type: "FeatureCollection", features: inView } as never,
  );
  const targetPath = compactPath(projection, target, 1);
  if (!targetPath) return null;
  const neighbourPaths = neighbours
    .map((f) => ({ id: String(f.id), d: compactPath(projection, f, 1) }))
    .filter((n) => n.d);

  return {
    locator: { size: LOCATOR_SIZE, targetPath, neighbourPaths },
    centroid,
    bounds,
  };
}

/**
 * Where the suburb sits in its state: the state boundary fitted into the
 * frame, the suburb's own polygon in the same projection, and its projected
 * centroid for a marker (a suburb is a few pixels wide at state scale).
 */
export function buildStateLocatorModel(
  stateFeature: SuburbFeature,
  suburbFeature: SuburbFeature,
  frame: { width: number; height: number; pad?: number } = { width: 320, height: 200 },
): StateLocatorModel | null {
  const pad = frame.pad ?? 8;
  const projection = geoMercator().fitExtent(
    [[pad, pad], [frame.width - pad, frame.height - pad]],
    stateFeature as never,
  );
  const statePath = compactPath(projection, stateFeature, 0);
  if (!statePath) return null;
  const suburbPath = compactPath(projection, suburbFeature, 1);
  const c = featureCentroid(suburbFeature);
  const projected = c ? projection([c.lon, c.lat]) : null;
  if (!projected) return null;
  return {
    width: frame.width,
    height: frame.height,
    statePath,
    suburbPath,
    marker: { x: projected[0], y: projected[1] },
  };
}
