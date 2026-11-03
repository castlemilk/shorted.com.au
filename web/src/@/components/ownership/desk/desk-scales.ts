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

export interface LensScale {
  lens: DeskLens;
  mode: LensScaleMode;
  /** The low and high ends of the scale, in the lens's own units (percentage points for a share). */
  lo: number;
  hi: number;
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
 * The scale a lens draws over a set of figures. A share starts at zero and runs to
 * the largest figure, so a cell's fill reads as its share of the largest. The flow
 * diverges around zero and is symmetric, so a fall and a rise of the same size
 * have the same strength. Null figures are left out of the domain.
 */
export function lensScale(lens: DeskLens, values: readonly (number | null)[]): LensScale {
  const figures = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (lens === "flow") {
    const reach = figures.reduce((max, v) => Math.max(max, Math.abs(v)), 0);
    return reach > 0
      ? { lens, mode: "diverging", lo: -reach, hi: reach }
      : { lens, mode: "diverging", lo: -1, hi: 1 };
  }
  const top = figures.reduce((max, v) => Math.max(max, v), 0);
  return {
    lens,
    mode: lens === "short" ? "short" : "sequential",
    lo: 0,
    hi: top > 0 ? top : 1,
  };
}

/** The strength of a fill as a whole percentage of the colour, 0 to 100. */
function strength(fraction: number): number {
  return Math.round(Math.min(1, Math.max(0, fraction)) * 100);
}

/** A colour at a strength over the paper, as a CSS colour function. Zero is the paper itself. */
function mix(colour: string, percent: number): string {
  return percent <= 0 ? PAPER : `color-mix(in srgb, ${colour} ${percent}%, ${PAPER})`;
}

/**
 * The fill for one figure on a scale, or null when there is no figure: a cell
 * with no figure is hatched by the caller, never painted as zero.
 */
export function lensFill(value: number | null, scale: LensScale): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (scale.mode === "diverging") {
    const reach = Math.max(Math.abs(scale.lo), Math.abs(scale.hi));
    const t = reach > 0 ? value / reach : 0;
    return mix(t < 0 ? INK : AMBER, strength(Math.abs(t)));
  }
  const span = scale.hi - scale.lo;
  const t = span > 0 ? (value - scale.lo) / span : 1;
  return mix(scale.mode === "short" ? SHORT : AMBER, strength(t));
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
 * The fill for a week's net change in the heatmap (spec 13.4): diverging ink to
 * paper to amber around zero, scaled to the largest week of the window.
 */
export function netFill(net: number | null, reach: number): string | null {
  if (net === null || !Number.isFinite(net)) return null;
  const scale = reach > 0 ? reach : 1;
  const t = net / scale;
  return mix(t < 0 ? INK : AMBER, strength(Math.abs(t)));
}
