import type { ChartBand, ChartLevel, ChartMarker } from "./types";

export interface LevelGeometry {
  /** Boxed on a card-coloured tag (ChartLevel.tag). */
  tag?: boolean;
  x1: number;
  x2: number;
  y: number;
  /** Right edge of the label (it is end-anchored), kept inside the plot. */
  labelX: number;
  /**
   * Baseline of the label, nudged clear of the other levels' labels. The line
   * stays at `y`.
   */
  labelY: number;
  label: string;
  color: string;
  dash?: string;
}
export interface BandGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  label?: string;
}
export interface MarkerGeometry {
  x: number;
  /** Where the label is anchored, kept inside the plot. */
  labelX: number;
  labelAnchor: "start" | "end";
  label: string;
  color: string;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// The chart draws labels in 10 px type, about 6 px a character. Layout cannot
// measure text, so a label's width is an estimate, enough to keep the label
// inside the plot.
export const LABEL_CHAR_PX = 6;
// A label sits this far from the line it names: above a level, beside a marker.
export const LABEL_INSET = 4;
// The closest two level labels' baselines may be: 10 px type and a pixel of air.
export const LABEL_SPACING = 11;
// The closest baselines of a label that sits in a tag box. The box runs 10 px
// above its baseline and 4 px below it (14 px), so a tagged label needs 15 px
// of baseline spacing or its box paints over the label beside it.
export const TAG_LABEL_SPACING = 15;

const labelWidth = (label: string) => label.length * LABEL_CHAR_PX;

/**
 * Where an end-anchored label sits for a line ending at `end`: just inside it,
 * but not so far left that the text starts before the plot. A label wider than
 * the plot ends at its right edge.
 */
const endLabelX = (end: number, width: number, innerW: number) =>
  Math.min(innerW, Math.max(end - LABEL_INSET, width));

export interface SpreadOptions {
  /** The highest baseline any label may take. Labels are pushed down to it. */
  top?: number;
  /** Per line, true when its label is in a tag box: that pair needs TAG_LABEL_SPACING. */
  tagged?: readonly boolean[];
}

/**
 * Baselines for the labels of lines at `ys`, in the order given. Each sits 4 px
 * above its line unless that is within the spacing of the label above it, in
 * which case it drops below that one (11 px, or 15 px beside a tag box). A
 * stack that would run past the plot floor is pulled back up to it, and a label
 * is never higher than `top`, so the stack spreads down from the top instead of
 * stacking on one baseline. The lines themselves never move.
 */
export function spreadLabels(
  ys: number[],
  innerH: number,
  opts: SpreadOptions = {},
): number[] {
  const top = opts.top ?? Number.NEGATIVE_INFINITY;
  const tagged = opts.tagged ?? [];
  const gap = (a: number, b: number) =>
    tagged[a] === true || tagged[b] === true ? TAG_LABEL_SPACING : LABEL_SPACING;
  // Indices, top of the plot first.
  const order = ys.map((_, i) => i).sort((a, b) => ys[a]! - ys[b]!);
  const baselines = ys.map((y) => Math.max(y - LABEL_INSET, top));
  for (let k = 1; k < order.length; k++) {
    const above = order[k - 1]!;
    const i = order[k]!;
    baselines[i] = Math.max(baselines[i]!, baselines[above]! + gap(above, i));
  }
  let lowest = innerH - LABEL_INSET; // the label of a line on the plot floor
  for (let k = order.length - 1; k >= 0; k--) {
    const i = order[k]!;
    baselines[i] = Math.min(baselines[i]!, lowest);
    if (k > 0) lowest = baselines[i]! - gap(order[k - 1]!, i);
  }
  return baselines;
}

interface VisibleLevel {
  level: ChartLevel;
  x1: number;
  x2: number;
  y: number;
}

/**
 * Pixel geometry for reference levels, bands and markers, clipped to the
 * inner plot. Pure: the chart hands in its scales and gets back only what is
 * visible, so a base that began before the loaded window clips to the left
 * edge and a level above the plot is simply absent. A value the scales cannot
 * place (NaN) is not visible either: it is dropped, never drawn at an edge.
 * The labels are placed here too, spread apart and inside the plot.
 */
export function layoutLevels(opts: {
  levels: readonly ChartLevel[];
  bands: readonly ChartBand[];
  markers: readonly ChartMarker[];
  x: (t: number) => number;
  yFor: (axis: "left" | "right") => (v: number) => number;
  innerW: number;
  innerH: number;
}): { levels: LevelGeometry[]; bands: BandGeometry[]; markers: MarkerGeometry[] } {
  const { innerW, innerH } = opts;
  const span = (from?: number, to?: number): [number, number] | null => {
    const x1 = from === undefined ? 0 : clamp(opts.x(from), 0, innerW);
    const x2 = to === undefined ? innerW : clamp(opts.x(to), 0, innerW);
    return x2 - x1 > 0 ? [x1, x2] : null;
  };

  const visible: VisibleLevel[] = [];
  for (const l of opts.levels) {
    const y = opts.yFor(l.axis)(l.value);
    if (!Number.isFinite(y) || y < 0 || y > innerH) continue;
    const s = span(l.from, l.to);
    if (!s) continue;
    visible.push({ level: l, x1: s[0], x2: s[1], y });
  }
  const ys = visible.map((v) => v.y);
  const labelYs = spreadLabels(ys, innerH, {
    tagged: visible.map((v) => !!v.level.tag),
  });
  const levels: LevelGeometry[] = visible.map(({ level, x1, x2, y }, i) => ({
    x1,
    x2,
    y,
    labelX: endLabelX(x2, labelWidth(level.label), innerW),
    labelY: labelYs[i]!,
    label: level.label,
    color: level.color,
    dash: level.dash,
    tag: level.tag,
  }));

  const bands: BandGeometry[] = [];
  for (const b of opts.bands) {
    const s = span(b.from, b.to);
    if (!s) continue;
    const yScale = opts.yFor(b.axis);
    const yHigh = clamp(yScale(b.high), 0, innerH);
    const yLow = clamp(yScale(b.low), 0, innerH);
    const height = Math.abs(yLow - yHigh);
    // `!(height > 0)`, not `height <= 0`: a NaN height, from a bound the scale
    // cannot place, is dropped too.
    if (!(height > 0)) continue;
    bands.push({ x: s[0], y: Math.min(yHigh, yLow), width: s[1] - s[0], height, color: b.color, label: b.label });
  }

  const markers: MarkerGeometry[] = [];
  for (const m of opts.markers) {
    const x = opts.x(m.t);
    if (!Number.isFinite(x) || x < 0 || x > innerW) continue;
    // Right of the line, or left of it where the right has no room.
    const width = labelWidth(m.label);
    const fitsRight = x + LABEL_INSET + width <= innerW;
    markers.push({
      x,
      labelX: fitsRight ? x + LABEL_INSET : endLabelX(x, width, innerW),
      labelAnchor: fitsRight ? "start" : "end",
      label: m.label,
      color: m.color,
    });
  }

  return { levels, bands, markers };
}
