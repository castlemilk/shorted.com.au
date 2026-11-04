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

export function regionPaint(tone: ChartRegion["tone"]): RegionPaint {
  if (tone === "live") return { cssFill: "hsl(var(--primary) / 0.06)" };
  return {
    fill: tone === "bearish" ? "#ef4444" : "#22c55e",
    fillOpacity: 0.1,
  };
}
