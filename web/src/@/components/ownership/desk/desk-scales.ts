/**
 * The desk's colour scales (spec 13.1). Every fill is a mix of a theme token with
 * the paper, so the two rooms read as the same instrument in light and dark: the
 * amber is the primary, the ink is the foreground, the paper is the background.
 *
 * NEVER RED OR GREEN. A map lens is a share of the register, and a notice flow
 * is not a market direction, so a diverging lens runs ink to paper to amber. The
 * one exception is the short-interest lens, which takes the chart's short colour
 * (rust, chart-theme's seriesColor("short")), because it is the chart's own series.
 *
 * A PURE MODULE. The fills are CSS colour functions over custom properties, so a
 * server render and the island write the same strings, and the theme decides the
 * values. A missing figure has no fill: a caller hatches that cell.
 */

import { seriesColor } from "~/@/components/charts/chart-theme";
import type { DeskLens } from "./desk-state";

export type LensScaleMode = "sequential" | "diverging" | "short";

/** The number of steps every lens is drawn in (spec 14.9): five bins, never a continuous ramp. */
export const BIN_COUNT = 5;

export interface LensScale {
  lens: DeskLens;
  mode: LensScaleMode;
  /** The low and high ends of the scale, in the lens's own units: the outer edges of the five bins. */
  lo: number;
  hi: number;
  /**
   * The width of one bin, a round number (1, 2, 2.5 or 5 times a power of ten), so every
   * threshold the legend prints is round. Sequential bins start at zero. A diverging
   * scale is symmetric about zero, by magnitude: -2 x step and below, -2 x step to -step,
   * -step to step (the centre, paper), step to 2 x step, and 2 x step and above, so a
   * rise and a fall of one size are drawn at one strength.
   */
  step: number;
  /** True when `hi` is the 98th percentile rather than the largest figure: the figures above it read in the top bin. */
  capped?: boolean;
}

/** The theme's paper, the ground every fill is mixed into. */
const PAPER = "hsl(var(--background))";
/** Burnt amber in light, phosphor amber in dark: the primary is theme-split by lightness. */
const AMBER = "hsl(var(--primary))";
/** Chocolate ink in light, warm sand in dark: the foreground. */
const INK = "hsl(var(--foreground))";
/** The chart's short-interest colour, the one lens drawn in a market series' hue. */
const SHORT = seriesColor("short");

/**
 * The round step a scale's bins are drawn at: the smallest of 1, 2, 2.5, 5 times a
 * power of ten that is at least `raw`, so `BIN_COUNT` of them reach the figure.
 */
export function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const exp = 10 ** Math.floor(Math.log10(raw));
  const f = raw / exp;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * exp;
}

/**
 * The scale a lens draws over a set of figures. A share starts at zero and runs to
 * the largest figure (or the 98th percentile of a long list), in five round bins.
 * The flow diverges around zero and is symmetric, so a fall and a rise of the same
 * size fall in mirrored bins. Null figures are left out of the domain.
 */
export function lensScale(lens: DeskLens, values: readonly (number | null)[]): LensScale {
  const figures = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (lens === "flow") {
    const { top: reach, capped } = scaleTop(figures.map((v) => Math.abs(v)));
    if (reach > 0) {
      const step = niceStep(reach / 2);
      return { lens, mode: "diverging", lo: -2 * step, hi: 2 * step, step, capped };
    }
    return { lens, mode: "diverging", lo: -2, hi: 2, step: 1 };
  }
  const { top, capped } = scaleTop(figures);
  const step = niceStep((top > 0 ? top : 1) / BIN_COUNT);
  return {
    lens,
    mode: lens === "short" ? "short" : "sequential",
    lo: 0,
    hi: step * BIN_COUNT,
    step,
    capped,
  };
}

/** The fewest figures a scale is capped over: a short list keeps its largest figure as its top. */
const CAP_FROM = 20;

/**
 * The top of a scale: the largest figure, or the 98th percentile once there are
 * CAP_FROM figures. One register summing to 242% (notices that overlap) once set
 * the whole market's scale, so every ordinary cell read as the paper; the few
 * figures above the cap read in the top bin, and the legend says "and above".
 */
function scaleTop(figures: readonly number[]): { top: number; capped: boolean } {
  const max = figures.reduce((m, v) => Math.max(m, v), 0);
  if (figures.length < CAP_FROM) return { top: max, capped: false };
  const sorted = [...figures].sort((a, b) => a - b);
  const p98 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.98))] ?? max;
  return p98 > 0 && p98 < max ? { top: p98, capped: true } : { top: max, capped: false };
}

/** The strength of a bin's colour as a whole percentage: the lightest bin is a fifth of the colour. */
const BIN_STRENGTH = [20, 40, 60, 80, 100] as const;
/**
 * A diverging scale's strengths from the fall's deepest bin to the rise's deepest. The
 * middle bin spans zero on both sides, so it is the paper; bins 1 and 3 mirror each other.
 */
const DIVERGING_STRENGTH = [100, 50, 0, 50, 100] as const;

/** The strength of one bin of a scale, as a whole percentage (the fill's colour share). */
export function binStrength(bin: number, scale: LensScale): number {
  return scale.mode === "diverging" ? (DIVERGING_STRENGTH[bin] ?? 0) : (BIN_STRENGTH[bin] ?? 100);
}

/** The ink-or-paper colour a label takes on a bin's fill: the paper on the two deepest steps, the ink elsewhere. */
export function labelOnBin(bin: number | null, scale: LensScale): string {
  if (bin === null) return INK;
  return binStrength(bin, scale) >= 80 ? PAPER : INK;
}

/** A colour at a strength over the paper, as a CSS colour function. Zero is the paper itself. */
function mix(colour: string, percent: number): string {
  return percent <= 0 ? PAPER : `color-mix(in srgb, ${colour} ${percent}%, ${PAPER})`;
}

/**
 * The bin a figure falls in, 0 (the lightest, or the deepest fall) to BIN_COUNT - 1, or
 * null when there is no figure. A sequential figure of zero is the paper: a measured
 * zero is drawn, but it is not a step on the scale.
 */
export function binOf(value: number | null, scale: LensScale): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (scale.mode === "diverging") {
    // By magnitude, so a fall and a rise of one size are always in mirrored bins, edges included.
    const s = scale.step;
    const magnitude = Math.abs(value);
    if (magnitude < s) return 2;
    if (magnitude < 2 * s) return value < 0 ? 1 : 3;
    return value < 0 ? 0 : 4;
  }
  return Math.min(BIN_COUNT - 1, Math.max(0, Math.floor(value / scale.step)));
}

/** A bin's fill: the figure's colour at the bin's strength, the paper for the middle of a diverging scale. */
export function binFill(bin: number, scale: LensScale): string {
  if (scale.mode === "diverging") {
    return mix(bin < BIN_COUNT / 2 ? INK : AMBER, binStrength(bin, scale));
  }
  return mix(scale.mode === "short" ? SHORT : AMBER, binStrength(bin, scale));
}

/**
 * The fill for one figure on a scale, or null when there is no figure: a cell
 * with no figure is hatched by the caller, never painted as zero. A sequential
 * zero is the paper.
 */
export function lensFill(value: number | null, scale: LensScale): string | null {
  const bin = binOf(value, scale);
  if (bin === null) return null;
  if (scale.mode !== "diverging" && value === 0) return PAPER;
  return binFill(bin, scale);
}

/**
 * The fill of a change band's direction in the flows (spec 13.3): an increase in
 * amber, a decrease in ink. A band is a direction of a notice flow, not a market
 * move, so neither is red or green.
 */
export function directionFill(direction: "up" | "down"): string {
  return direction === "up" ? mix(AMBER, 100) : mix(INK, 100);
}

/**
 * The scale of a week's net change in the heatmap (spec 13.4): the diverging bins
 * around zero, scaled to the largest week of the window.
 */
export function netScale(reach: number): LensScale {
  const top = reach > 0 ? reach : 1;
  return lensScale("flow", [-top, top]);
}

/**
 * The scale of a week's notice count in the heatmap: five whole-notice bins over the
 * most notices in one cell (spec 14.9). A bin edge is a whole number, so the legend
 * prints counts and never a fraction of a notice.
 */
export function countScale(reach: number): LensScale {
  const top = reach > 0 ? reach : 1;
  const step = Math.max(1, Math.ceil(niceStep(top / BIN_COUNT)));
  return { lens: "disclosed", mode: "sequential", lo: 0, hi: step * BIN_COUNT, step };
}

/** The fill for a week's net change in the heatmap, or null when the week states no figure. */
export function netFill(net: number | null, reach: number): string | null {
  return lensFill(net, netScale(reach));
}
