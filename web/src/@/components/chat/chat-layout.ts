/**
 * Layout rules for the chat's tables, charts and reading tooltips: which columns a
 * table draws at its width, where a reading's tooltip sits in the viewport, where a
 * chart's latest-value label can go without crossing its line, and whether a reading
 * is still in view. Pure, so the eager table code and the lazily loaded charts share
 * it, and it is tested on its own. Nothing here reads the DOM.
 *
 * The widths below are measured, not designed. A table draws to the width of its own
 * scroll region (the client width, which excludes a classic scrollbar), and the chain
 * from the sheet inwards is:
 *
 *   desktop sidebar  384px  the sheet keeps sheet.tsx's `sm:max-w-sm` (24rem), which
 *                           caps the 450px the sidebar asks for at 384px
 *     - 1px border and 32px of thread padding, then the bubble's 85% width
 *     - 2px tool border and 20px tool padding
 *   => desktop table ~276px (compact); ~263px with a classic scrollbar taking 13-15px
 *   phone            375px  the sheet takes the whole width: ~269px at 375px, ~223px at 320px
 *   /chat page       ~620-720px (full)
 *
 * A table draws the columns that fit its width, so the figures a reader needs come
 * first and nothing is scrolled out of sight at the sidebar's width.
 */

export type TableTier = "compact" | "standard" | "full";

/** The narrowest table, in px, that draws the standard columns (a 64px trend beside the figures). */
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

/** Whether two rectangles share any area. Touching edges do not count. */
export function rectsOverlap(a: ViewportRect, b: ViewportRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/**
 * Whether a reading at `anchor` is still in view: it overlaps every region that clips
 * it (the table's scroll region, the conversation, the window). A reading scrolled out
 * of one of them has no tooltip, rather than a tooltip that floats free of it. An anchor
 * with no area has not been laid out (a test with no layout, or a first paint), and
 * nothing is known to be out of view, so it is in view.
 */
export function readingIsInView(anchor: ViewportRect, clips: readonly ViewportRect[]): boolean {
  if (anchor.right === anchor.left && anchor.bottom === anchor.top) return true;
  return clips.every((clip) => rectsOverlap(anchor, clip));
}

/** A point in a chart's plot, in plot coordinates (the origin is the plot's top left). */
export interface PlotPoint {
  x: number;
  y: number;
}

/** The estimated advance of one character of the latest-value label (11px, semibold). */
export const LABEL_CHAR_PX = 7;
/** How far the label's baseline sits above the point it labels, when it sits above it. */
const LABEL_LIFT_PX = 7;
/** The label's glyph box: its height above the baseline, and how far its halo goes below. */
const LABEL_ASCENT_PX = 9;
const LABEL_DESCENT_PX = 2;
/** The outline the label is drawn with, which the line must not be read through. */
const LABEL_HALO_PX = 2;
/** The room under the plot for a label that flips below its point (the chart's bottom margin, less a gap). */
const LABEL_BELOW_ROOM_PX = 18;
/** The baseline of the label in the band over the plot, which the chart's top margin (16px) holds. */
const TOP_BAND_BASELINE_PX = -4;

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * Whether the polyline through `line` (in ascending x) enters `box`. The line is straight
 * between points, so each segment is checked over the part of its x-span the box covers,
 * not only at its ends: a peak between two readings is a crossing too.
 */
export function lineCrossesBox(line: readonly PlotPoint[], box: Box): boolean {
  if (line.length === 1) {
    const [only] = line;
    return only !== undefined && only.x >= box.left && only.x <= box.right && only.y >= box.top && only.y <= box.bottom;
  }
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!;
    const b = line[i]!;
    const left = Math.max(Math.min(a.x, b.x), box.left);
    const right = Math.min(Math.max(a.x, b.x), box.right);
    if (left > right) continue;
    let low: number;
    let high: number;
    if (a.x === b.x) {
      low = Math.min(a.y, b.y);
      high = Math.max(a.y, b.y);
    } else {
      const yAt = (x: number) => a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x);
      const y1 = yAt(left);
      const y2 = yAt(right);
      low = Math.min(y1, y2);
      high = Math.max(y1, y2);
    }
    if (high >= box.top && low <= box.bottom) return true;
  }
  return false;
}

/**
 * Where a chart's latest-value label goes. It labels the last reading, at the plot's right
 * edge, so it sits above that point and ends at its x. When the line runs through the space
 * above the reading (the series' own peak, a reading or two back), the label goes below the
 * point. When the line runs through both (a series rising into the reading from below and
 * peaking just before it), the label goes in the band above the plot: every value lies
 * inside the plot's domain, so the line cannot reach that band, and the chart's top margin
 * holds the label. The label is never placed left of the plot's left edge: a label wider
 * than the plot is held at 0.
 *
 * `line` is the whole series in plot coordinates, and `latest` is its last point. The
 * returned x is the label's end (text-anchor "end"), and y its baseline.
 */
export function placeLatestLabel(opts: {
  line: readonly PlotPoint[];
  latest: PlotPoint;
  text: string;
  plotHeight: number;
}): { x: number; y: number; placement: LatestLabelPlacement } {
  const { line, latest, text, plotHeight } = opts;
  const width = text.length * LABEL_CHAR_PX;
  const x = Math.max(latest.x, width);

  const aboveBaseline = latest.y - LABEL_LIFT_PX;
  const above = labelBox(x, width, aboveBaseline);
  if (!lineCrossesBox(line, above)) return { x, y: aboveBaseline, placement: "above" };

  const belowBaseline = latest.y + LABEL_LIFT_PX + LABEL_ASCENT_PX;
  const below = labelBox(x, width, belowBaseline);
  const belowFits = belowBaseline + LABEL_DESCENT_PX <= plotHeight + LABEL_BELOW_ROOM_PX;
  if (belowFits && !lineCrossesBox(line, below)) {
    return { x, y: belowBaseline, placement: "below" };
  }
  // Both sides of the reading are crossed: the label moves up into the band over the plot.
  return { x, y: TOP_BAND_BASELINE_PX, placement: "top" };
}

/** Where the latest label sits: above or below its point, or in the band over the plot. */
export type LatestLabelPlacement = "above" | "below" | "top";

/** The glyph box of a label whose end is at `x` and whose baseline is at `baseline`. */
function labelBox(x: number, width: number, baseline: number): Box {
  return {
    left: x - width - LABEL_HALO_PX,
    right: x + LABEL_HALO_PX,
    top: baseline - LABEL_ASCENT_PX - LABEL_HALO_PX,
    bottom: baseline + LABEL_DESCENT_PX + LABEL_HALO_PX,
  };
}
