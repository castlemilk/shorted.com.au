// Pure, dependency-free helpers for the housing zoom map's level-of-detail
// rendering (national state view <-> viewport-culled suburb view). No d3/DOM
// imports, so they can be unit-tested and imported from the server page.

export type DetailLevel = "national" | "suburb";

/**
 * Zoom scale at/above which the map switches from states to suburbs by pure zoom
 * (no click). ~k=4 shows roughly a quarter of the country width — a state-sized
 * region. Clicking a state also enters suburb detail regardless of scale (see the
 * component's `enteredState`), so a large state that frames below this still works.
 */
export const SUBURB_SWITCH_SCALE = 4;

/** Max suburb <path> nodes rendered at once (after viewport culling). */
export const CULL_CAP = 800;

export function detailLevelForScale(
  k: number,
  threshold = SUBURB_SWITCH_SCALE,
): DetailLevel {
  return k >= threshold ? "suburb" : "national";
}

export interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** A feature's projected bounding box: [[x0,y0],[x1,y1]] (d3 path.bounds shape). */
export type Bounds = [[number, number], [number, number]];

export interface BoundedFeature<T> {
  id: string;
  feature: T;
  bounds: Bounds;
  area: number;
}

export function boundsArea(b: Bounds): number {
  return Math.max(0, b[1][0] - b[0][0]) * Math.max(0, b[1][1] - b[0][1]);
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

/**
 * The visible viewport in PROJECTED coordinates, for a d3 zoom transform {k,x,y}
 * over a width×height screen, expanded by `margin` (a fraction of the viewport's
 * size on each edge, so suburbs just off-screen are pre-rendered before they
 * scroll into view).
 */
export function viewportInProjected(
  k: number,
  x: number,
  y: number,
  width: number,
  height: number,
  margin = 0.15,
): Rect {
  const minX = (0 - x) / k;
  const maxX = (width - x) / k;
  const minY = (0 - y) / k;
  const maxY = (height - y) / k;
  const mx = (maxX - minX) * margin;
  const my = (maxY - minY) * margin;
  return { minX: minX - mx, minY: minY - my, maxX: maxX + mx, maxY: maxY + my };
}

/** Screen-center point in PROJECTED coordinates for the given transform. */
export function projectedCenter(
  k: number,
  x: number,
  y: number,
  width: number,
  height: number,
): [number, number] {
  return [(width / 2 - x) / k, (height / 2 - y) / k];
}

/**
 * Features whose bounds intersect the viewport, capped at `cap`. When more than
 * `cap` are visible, keep the largest-area ones (they read at a distance); this
 * only bites at the shallow end of the suburb band.
 */
export function cullFeatures<T extends { bounds: Bounds; area: number }>(
  features: T[],
  viewport: Rect,
  cap = CULL_CAP,
): T[] {
  const visible: T[] = [];
  for (const f of features) {
    if (
      rectsIntersect(viewport, {
        minX: f.bounds[0][0],
        minY: f.bounds[0][1],
        maxX: f.bounds[1][0],
        maxY: f.bounds[1][1],
      })
    ) {
      visible.push(f);
    }
  }
  if (visible.length <= cap) return visible;
  return visible.sort((a, b) => b.area - a.area).slice(0, cap);
}

/**
 * The "focused" state for a viewport center: the state whose bounds contain the
 * center, preferring the SMALLEST such bbox (so ACT — nested inside NSW's bbox —
 * wins over NSW). Falls back to the state whose bbox-center is nearest when the
 * point is outside every state (e.g. over ocean).
 */
export function focusedStateFor(
  center: [number, number],
  states: { id: string; bounds: Bounds }[],
): string | null {
  const [cx, cy] = center;
  let best: { id: string; area: number } | null = null;
  let nearest: string | null = null;
  let nearestD = Infinity;
  for (const s of states) {
    const [[x0, y0], [x1, y1]] = s.bounds;
    if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) {
      const area = boundsArea(s.bounds);
      if (!best || area < best.area) best = { id: s.id, area };
    }
    const bx = (x0 + x1) / 2;
    const by = (y0 + y1) / 2;
    const d = (bx - cx) ** 2 + (by - cy) ** 2;
    if (d < nearestD) {
      nearestD = d;
      nearest = s.id;
    }
  }
  return best ? best.id : nearest;
}

/** Per-state hover stats for the national view (built from GetHousingOverview). */
export interface StateStat {
  median: number;
  yoyPct: number;
  qoqPct: number;
  capital: string;
}
