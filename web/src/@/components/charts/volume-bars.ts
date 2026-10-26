/**
 * Volume as bars, the way every market chart draws it.
 *
 * Volume was an area, one shape joining each session's volume to the next, so
 * it read as a series rising and falling between days: nobody could tell what
 * the grey shape under the price was. A bar per session says "this much traded
 * that day". The bars are still ONE svg path (a closed rectangle per session in
 * its `d`), never a node per point: a year of BHP is ~250 sessions, and the
 * whole history several thousand.
 *
 * Pure: no React and no DOM, so the geometry is tested on its own.
 */
import { bisector } from "@visx/vendor/d3-array";
import type { ChartPoint } from "./types";

/** The share of the gap to its nearer neighbour that a bar takes. */
export const VOLUME_BAR_FILL = 0.7;
/** The widest a bar is drawn (px), however few sessions are on screen. */
export const VOLUME_BAR_MAX_W = 12;
/** The narrowest (px): a decimated history is a bar a pixel, never a hairline. */
export const VOLUME_BAR_MIN_W = 1;
/** A lone session has no neighbour to measure from. */
const LONE_BAR_W = 6;

export interface VolumeBarGeometry {
  /** Pixel x of each session's centre. */
  x: (t: number) => number;
  /** Pixel y of a volume's top. */
  y: (v: number) => number;
  /** Pixel y of zero volume: the foot of the plot. */
  baseline: number;
  /** The plot's width: a bar at either end is cut at its edge, not drawn over the axis. */
  width: number;
}

const r = (n: number) => Math.round(n * 100) / 100;

/**
 * The width of bar `i` among bars centred at `xs`: VOLUME_BAR_FILL of the gap to
 * its NEARER neighbour, so a Monday is as wide as a Tuesday though the weekend
 * sits before it.
 */
export function volumeBarWidth(xs: readonly number[], i: number): number {
  const here = xs[i]!;
  const prev = i > 0 ? here - xs[i - 1]! : Infinity;
  const next = i < xs.length - 1 ? xs[i + 1]! - here : Infinity;
  const gap = Math.min(prev, next);
  if (!Number.isFinite(gap)) return LONE_BAR_W;
  return Math.min(VOLUME_BAR_MAX_W, Math.max(VOLUME_BAR_MIN_W, gap * VOLUME_BAR_FILL));
}

/** One bar's rectangle, cut to the plot; null when nothing of it shows. */
export function volumeBarRect(
  xs: readonly number[],
  i: number,
  v: number,
  g: VolumeBarGeometry,
): { x: number; y: number; width: number; height: number } | null {
  const cx = xs[i]!;
  const top = g.y(v);
  if (!Number.isFinite(cx) || !Number.isFinite(top)) return null;
  const half = volumeBarWidth(xs, i) / 2;
  const left = Math.max(0, cx - half);
  const right = Math.min(g.width, cx + half);
  const height = g.baseline - top;
  if (right <= left || !(height > 0)) return null;
  return { x: left, y: top, width: right - left, height };
}

/** Every session's bar as one path `d`; "" when there is nothing to draw. */
export function volumeBarsPath(points: readonly ChartPoint[], g: VolumeBarGeometry): string {
  const xs = points.map((p) => g.x(p.t));
  let d = "";
  for (let i = 0; i < points.length; i++) {
    const b = volumeBarRect(xs, i, points[i]!.v, g);
    if (!b) continue;
    d += `M${r(b.x)},${r(g.baseline)}V${r(b.y)}H${r(b.x + b.width)}V${r(g.baseline)}Z`;
  }
  return d;
}

const tBisector = bisector<ChartPoint, number>((d) => d.t);

/**
 * The bar of the session nearest `t`, measured among `points` (the raw volume on
 * screen), for the highlight under a reading. Null when there is none to draw.
 */
export function volumeBarAt(
  points: readonly ChartPoint[],
  t: number,
  g: VolumeBarGeometry,
): { x: number; y: number; width: number; height: number } | null {
  if (!points.length) return null;
  let i = tBisector.left(points as ChartPoint[], t, 0);
  if (i >= points.length) i = points.length - 1;
  else if (i > 0 && t - points[i - 1]!.t < points[i]!.t - t) i -= 1;
  // Only the bar and its neighbours set its width, so measure just those three.
  const lo = Math.max(0, i - 1);
  const hi = Math.min(points.length - 1, i + 1);
  const xs: number[] = [];
  for (let k = lo; k <= hi; k++) xs.push(g.x(points[k]!.t));
  return volumeBarRect(xs, i - lo, points[i]!.v, g);
}
