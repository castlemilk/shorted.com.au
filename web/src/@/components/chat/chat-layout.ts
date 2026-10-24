/**
 * Layout rules for the chat's tables and reading tooltips: which columns a table
 * draws at its width, and where a sparkline's tooltip sits in the viewport. Pure, so
 * the eager table code and the lazily loaded charts share it, and it is tested on its
 * own. Nothing here reads the DOM.
 *
 * The sidebar is the narrow case. A table in it is about 333px wide on a desktop and
 * 220 to 290px on a phone, because the thread, the bubble and the tool each take their
 * padding. A table on the /chat page is about 620px. The table measures itself and
 * draws the columns that fit its width, so the figures a reader needs come first.
 */

export type TableTier = "compact" | "standard" | "full";

/** The narrowest table, in px, that draws the standard columns. */
export const STANDARD_MIN_WIDTH = 330;
/** The narrowest table, in px, that draws every column. */
export const FULL_MIN_WIDTH = 480;

const TIER_RANK: Readonly<Record<TableTier, number>> = {
  compact: 0,
  standard: 1,
  full: 2,
};

/**
 * The tier a table of `width` px draws at. A table with no measured width (0: a test
 * with no layout, or a first paint before the measure) takes the full table, so
 * nothing is hidden that the measure would not hide.
 */
export function tableTierFor(width: number): TableTier {
  if (!(width > 0) || width >= FULL_MIN_WIDTH) return "full";
  if (width >= STANDARD_MIN_WIDTH) return "standard";
  return "compact";
}

/** True when a column that first appears at `from` is drawn at `tier`. */
export function tierAtLeast(tier: TableTier, from: TableTier = "compact"): boolean {
  return TIER_RANK[tier] >= TIER_RANK[from];
}

export interface ViewportRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface BoxSize {
  width: number;
  height: number;
}

/** The space between a tooltip and the reading it describes. */
export const TOOLTIP_GAP_PX = 6;
/** The least space a tooltip keeps from every edge of the viewport. */
export const TOOLTIP_EDGE_PX = 8;

/**
 * Where a tooltip for a reading at `anchor` goes, in viewport coordinates, so it is
 * fully visible. It sits above the reading, on the reading's trailing edge, the way the
 * sparkline's tooltip always has. It flips below the reading when there is no room
 * above (a row just under the sticky header, or at the top of the window), and is
 * clamped inside the viewport on both axes when neither side fits (a last column at
 * the right edge of a narrow screen).
 */
export function placeTooltip(
  anchor: ViewportRect,
  size: BoxSize,
  viewport: BoxSize,
): { left: number; top: number; placement: "above" | "below" } {
  const above = anchor.top - TOOLTIP_GAP_PX - size.height;
  const below = anchor.bottom + TOOLTIP_GAP_PX;
  const fitsAbove = above >= TOOLTIP_EDGE_PX;
  const fitsBelow = below + size.height <= viewport.height - TOOLTIP_EDGE_PX;
  const placement = !fitsAbove && fitsBelow ? "below" : "above";

  const top = clamp(
    placement === "above" ? above : below,
    TOOLTIP_EDGE_PX,
    viewport.height - size.height - TOOLTIP_EDGE_PX,
  );
  const left = clamp(
    anchor.right - size.width,
    TOOLTIP_EDGE_PX,
    viewport.width - size.width - TOOLTIP_EDGE_PX,
  );
  return { left, top, placement };
}

/** `value` held between `min` and `max`. A `max` below `min` (a box wider than the viewport) gives `min`. */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}
