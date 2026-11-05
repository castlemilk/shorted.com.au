import { LABEL_CHAR_PX } from "./chart-levels";
import type { ChartEvent } from "./types";

/**
 * Pixel geometry for the dots and callouts drawn on a series (ChartEvent and
 * ChartAnnotation). Pure: no React and no DOM, so the placement is tested on its
 * own. A dot the scales cannot place, or that lies off the plot, is dropped.
 */

/** The fill of an event dot, by its tone. Entries are amber, exits clay rust. */
export const EVENT_FILL: Record<ChartEvent["tone"], string> = {
  entry: "hsl(var(--primary))",
  exit: "hsl(var(--accent))",
  neutral: "hsl(var(--foreground))",
};

/** An annotation's dot. It names a value, so it takes the foreground. */
export const ANNOTATION_FILL = "hsl(var(--foreground))";

/** The gap between a dot and its label, and the label's height above the dot. */
const DOT_LABEL_GAP = 6;
const LABEL_TOP = 10;

export interface PointMarkInput {
  kind: "event" | "annotation";
  t: number;
  v: number;
  axis: "left" | "right";
  label?: string;
  /** A CSS colour for the dot (a token). */
  fill: string;
}

export interface PointMarkGeometry {
  kind: "event" | "annotation";
  x: number;
  y: number;
  fill: string;
  label?: string;
  labelX: number;
  labelY: number;
  labelAnchor: "start" | "end";
}

export interface PointMarkOptions {
  x: (t: number) => number;
  yFor: (axis: "left" | "right") => (v: number) => number;
  innerW: number;
  innerH: number;
}

/**
 * Where each dot sits and where its label goes: to the right of the dot, or to
 * its left where the right has no room, and above it, or below it where the top
 * of the plot is too near.
 */
export function layoutPointMarks(
  items: readonly PointMarkInput[],
  opts: PointMarkOptions,
): PointMarkGeometry[] {
  const out: PointMarkGeometry[] = [];
  for (const it of items) {
    const x = opts.x(it.t);
    const y = opts.yFor(it.axis)(it.v);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < 0 || x > opts.innerW || y < 0 || y > opts.innerH) continue;
    const width = (it.label ?? "").length * LABEL_CHAR_PX;
    const fitsRight = x + DOT_LABEL_GAP + width <= opts.innerW;
    const labelY = y - DOT_LABEL_GAP >= LABEL_TOP ? y - DOT_LABEL_GAP : y + 14;
    out.push({
      kind: it.kind,
      x,
      y,
      fill: it.fill,
      label: it.label,
      labelX: fitsRight ? x + DOT_LABEL_GAP : x - DOT_LABEL_GAP,
      labelY,
      labelAnchor: fitsRight ? "start" : "end",
    });
  }
  return out;
}
