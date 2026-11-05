import { LABEL_CHAR_PX } from "./chart-levels";
import type { ChartRegion } from "./types";

/**
 * How a shaded region is painted. The divergence pair keeps its fixed fills
 * (the chart's output is unchanged for every caller that uses them); "live"
 * paints a token, so it follows the theme. Pure: no React and no DOM.
 */
export interface RegionPaint {
  /** An SVG `fill` attribute value. Absent for a token tone. */
  fill?: string;
  fillOpacity?: number;
  /**
   * A CSS fill for a token tone, applied as a style: a `var()` inside a
   * presentation attribute is not reliable across engines.
   */
  cssFill?: string;
}

/** The padding a region label keeps from the region's left edge and its text. */
const REGION_LABEL_PAD_PX = 12;

/**
 * Whether a region's label is written on the region, as text, rather than only
 * as a hover title. Only the live tone is labelled: "Recorded since <date>" is
 * the one a reader must see on a touch screen, where a title never shows. It
 * takes the label when the band is wide enough to hold it.
 */
export function regionLabelShown(
  tone: ChartRegion["tone"],
  label: string | undefined,
  width: number,
): boolean {
  if (tone !== "live" || !label) return false;
  return label.length * LABEL_CHAR_PX + REGION_LABEL_PAD_PX <= width;
}

export function regionPaint(tone: ChartRegion["tone"]): RegionPaint {
  if (tone === "live") return { cssFill: "hsl(var(--primary) / 0.06)" };
  return {
    fill: tone === "bearish" ? "#ef4444" : "#22c55e",
    fillOpacity: 0.1,
  };
}
