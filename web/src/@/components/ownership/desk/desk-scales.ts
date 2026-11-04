/**
 * The desk's colour scales (spec 13.1). Every fill is a theme token: the five
 * stops of the ramp (`--desk-bin-0` to `-4`), the ink printed on each stop
 * (`--desk-bin-ink-*`), and for a diverging lens the falls and rises
 * (`--desk-fall-*`, `--desk-rise-*`, `--desk-div-ink-*`). The module names the
 * stops; the theme decides their values, so the server and the island write the
 * same strings and the two rooms read as one instrument (globals.css sets them).
 *
 * NEVER RED OR GREEN. A map lens is a share of the register, and a notice flow
 * is not a market direction, so a diverging lens runs ink to paper to amber. The
 * one exception is the short-interest lens, which takes the chart's short colour
 * (rust, chart-theme's seriesColor("short")), because it is the chart's own series.
 * It is the only fill that is a mix at run time: the rust at its bin's strength
 * over the paper.
 *
 * A PURE MODULE. No React state, no DOM, no fetch. A missing figure has no fill:
 * a caller hatches that cell.
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

/** The theme's paper, the ground every fill is set on and the zero of a diverging scale. */
const PAPER = "hsl(var(--background))";
/** The foreground: the ink a label takes when no figure sits under it. */
const INK = "hsl(var(--foreground))";
/** The chart's short-interest colour, the one lens drawn in a market series' hue. */
const SHORT = seriesColor("short");

/**
 * A diverging scale's fills from the fall's deepest bin to the rise's deepest. The
 * middle bin spans zero on both sides, so it is the paper.
 */
const DIVERGING_FILL = [
  "hsl(var(--desk-fall-2))",
  "hsl(var(--desk-fall-1))",
  PAPER,
  "hsl(var(--desk-rise-1))",
  "hsl(var(--desk-rise-2))",
] as const;

/** A bin index clamped to the five the scale draws. */
function clampBin(bin: number): number {
  return Math.min(BIN_COUNT - 1, Math.max(0, bin));
}

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
  // The two changes diverge around zero: a notice's net change and an index fund's change in shares.
  if (lens === "flow" || lens === "index_flow") {
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

/**
 * The short lens's strengths, as a whole percentage of the rust mixed into the
 * paper: the lightest bin is a fifth of the colour. The short lens is the spec's one
 * exception to the ramp (13.1), so its fills keep this mix.
 */
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

/**
 * The ink a label takes on a bin's fill: the ink token the theme sets for that stop
 * (checked against its fill for WCAG AA at 11px, see globals.css). A null bin, a
 * cell with no figure, takes the foreground. The short lens's fills are rust mixes,
 * not ramp stops, so the AA check does not cover them: its top bins miss 4.5:1 with
 * these inks (desk-ramp-contrast.test.ts does not test the short lens).
 */
export function labelOnBin(bin: number | null, scale: LensScale): string {
  if (bin === null) return INK;
  const b = clampBin(bin);
  return scale.mode === "diverging" ? `hsl(var(--desk-div-ink-${b}))` : `hsl(var(--desk-bin-ink-${b}))`;
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

/**
 * A bin's fill: the theme's stop for the bin. A diverging scale's middle bin is the
 * paper; the short lens mixes the chart's rust into the paper at the bin's strength.
 */
export function binFill(bin: number, scale: LensScale): string {
  const b = clampBin(bin);
  if (scale.mode === "diverging") return DIVERGING_FILL[b] ?? PAPER;
  if (scale.mode === "short") return mix(SHORT, binStrength(b, scale));
  return `hsl(var(--desk-bin-${b}))`;
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
 * move, so neither is red or green. The deepest stops of the diverging ramp.
 */
export function directionFill(direction: "up" | "down"): string {
  return direction === "up" ? "hsl(var(--desk-rise-2))" : "hsl(var(--desk-fall-2))";
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
