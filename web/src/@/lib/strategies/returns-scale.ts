/**
 * The colour scale of the returns heatmaps (ReturnsHeatmapTable): annual
 * returns by year and monthly returns by month. Pure: no React and no DOM, so
 * the bins and the fills are tested on their own.
 *
 * A return is a direction of a number, so the fills use the semantic pair
 * (DESIGN.md, Semantic Quarantine Rule). Every cell carries ink text, never
 * paper text: the red fill tops out at 60% and the green at 80%, which keeps
 * the ink above 4.5:1 in both themes (the contrast test reads the real tokens
 * from globals.css).
 */

export type ReturnsScale = "annual" | "monthly";

export type ReturnBinKey = "strong-down" | "down" | "flat" | "up" | "strong-up";

export interface ReturnBin {
  key: ReturnBinKey;
  /** The direction of the number: -1 down, 0 about zero, 1 up. */
  sign: -1 | 0 | 1;
  /** The percentage of the signal colour mixed over the paper; null for "about zero". */
  strength: number | null;
}

/** The strong-move threshold, in percent, for each scale. */
export const RETURNS_STRONG_PCT: Record<ReturnsScale, number> = {
  annual: 10,
  monthly: 5,
};

/** Below this magnitude, in percent, a return reads as about zero (no fill). */
export const RETURNS_NEAR_ZERO_PCT = 0.5;

/** The most a red cell is mixed to (DESIGN contrast cap: ink stays above 4.5:1). */
export const RED_FILL_MAX = 60;
/** The most a green cell is mixed to. */
export const GREEN_FILL_MAX = 80;

/** A value the scale cannot place (NaN, infinite) gets no bin. */
export function returnBin(value: number, scale: ReturnsScale): ReturnBin | null {
  if (!Number.isFinite(value)) return null;
  const strong = RETURNS_STRONG_PCT[scale];
  if (value <= -strong) return { key: "strong-down", sign: -1, strength: RED_FILL_MAX };
  if (value <= -RETURNS_NEAR_ZERO_PCT) return { key: "down", sign: -1, strength: 40 };
  if (value < RETURNS_NEAR_ZERO_PCT) return { key: "flat", sign: 0, strength: null };
  if (value < strong) return { key: "up", sign: 1, strength: 40 };
  return { key: "strong-up", sign: 1, strength: GREEN_FILL_MAX };
}

/**
 * The cell background for a bin: the signal colour mixed over the paper token,
 * or null for a bin with no fill. The mix is a colour-mix, so it follows the
 * theme's semantic tokens (the dark pair is brighter).
 */
export function binFill(bin: ReturnBin): string | null {
  if (bin.strength === null) return null;
  const signal = bin.sign > 0 ? "--semantic-green" : "--semantic-red";
  return `color-mix(in srgb, var(${signal}) ${bin.strength}%, hsl(var(--returns-paper)))`;
}

/**
 * The ink a filled cell's text uses, in both themes. It is never the paper
 * token: a cell's fill is a tint of the paper, so the paper cannot be the ink.
 */
export const RETURNS_INK = "hsl(var(--returns-ink))";

/**
 * The text of a cell with no fill (about zero, or a state with no figure). It
 * sits on the card, not on the tinted paper, so it is the theme's foreground:
 * the dark ink would vanish on a dark card.
 */
export const RETURNS_PLAIN_INK = "hsl(var(--foreground))";

const MINUS = "−";

/** The legend's words for each bin, in order from the most negative. */
export function returnsLegend(scale: ReturnsScale): string[] {
  const s = RETURNS_STRONG_PCT[scale];
  const n = RETURNS_NEAR_ZERO_PCT;
  return [
    `≤ ${MINUS}${s}%`,
    `${MINUS}${s} to ${MINUS}${n}%`,
    "about 0",
    `${n} to ${s}%`,
    `≥ ${s}%`,
  ];
}

/**
 * A coverage fraction, clamped to [0, 1], for a bar's width. Null (not known)
 * gives 0: the bar draws nothing, and the figure says why.
 */
export function coverageFraction(coverage: number | null | undefined): number {
  if (coverage == null || !Number.isFinite(coverage)) return 0;
  return Math.min(1, Math.max(0, coverage));
}

/** Coverage under this fraction is hatched: the figure is measured on too few names. */
export const COVERAGE_HATCH_BELOW = 0.8;

/** Whether a coverage figure is known and under the hatch line. Unknown is not hatched. */
export function coverageHatched(coverage: number | null | undefined): boolean {
  if (coverage == null || !Number.isFinite(coverage)) return false;
  return coverage < COVERAGE_HATCH_BELOW;
}
