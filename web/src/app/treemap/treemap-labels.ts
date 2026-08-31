/**
 * Pure layout maths for the industry tree map's labels and dimensions.
 *
 * Kept out of `treeMap.tsx` so it can be unit tested without loading @visx.
 */

const HEADER_HEIGHT = 20; // Height reserved for sector labels + icons
// Phones pay this per industry (8 of them), so a 20px band costs ~160px of the
// 440px map — trimming it is what gives the leaf tiles room for their codes.
const HEADER_HEIGHT_MOBILE = 15;
const TREEMAP_HEIGHT = 700;
// Phones get a shorter map: 700px of dense tiles at ~390px wide is unreadable
// and dominates the page.
const TREEMAP_HEIGHT_MOBILE = 440;
const MOBILE_WIDTH_BREAKPOINT = 520;
// Below this viewport width the tiles are too small to clear the wide-viewport
// 12px floor, so labels are sized to the tile rather than gated on tile size.
const COMPACT_WIDTH_BREAKPOINT = 1024;

// Rough advance width of an uppercase glyph as a fraction of the font size, for
// the system sans stack. Lets us size a label to its tile instead of gating on
// a fixed tile size.
export const LEAF_CHAR_WIDTH_RATIO = 0.64;

export const clamp = (min: number, v: number, max: number) =>
  Math.max(min, Math.min(max, v));

export const isMobileWidth = (width: number) =>
  width > 0 && width < MOBILE_WIDTH_BREAKPOINT;

export const treemapHeightFor = (width: number) =>
  isMobileWidth(width) ? TREEMAP_HEIGHT_MOBILE : TREEMAP_HEIGHT;

export const headerHeightFor = (width: number) =>
  isMobileWidth(width) ? HEADER_HEIGHT_MOBILE : HEADER_HEIGHT;

/**
 * Font size for a leaf tile's stock code, or null when the tile genuinely
 * cannot carry a legible label.
 *
 * Phones were the problem this solves: at ~390px wide almost every tile falls
 * under the 60x32 wide-viewport gate, so the codes disappeared entirely and the
 * map became an unlabelled colour field. On narrow viewports we allow much
 * smaller type and take the largest size the tile can actually carry —
 * area-derived sizing pins nearly every small tile at the floor, wasting the
 * room the larger tiles do have.
 */
export function leafLabelFontSize(
  nodeWidth: number,
  nodeHeight: number,
  label: string,
  viewportWidth: number,
): number | null {
  const chars = Math.max(label.length, 1);
  const isMobile = isMobileWidth(viewportWidth);
  const isCompact =
    viewportWidth > 0 && viewportWidth < COMPACT_WIDTH_BREAKPOINT;
  const minFont = isCompact ? (isMobile ? 7 : 8) : 12;
  const maxFont = isCompact ? (isMobile ? 12 : 14) : 20;

  // Largest size that still fits the tile in both axes, leaving a little
  // breathing room inside the tile's stroke.
  const fits = Math.min(
    Math.floor((nodeWidth - 4) / (chars * LEAF_CHAR_WIDTH_RATIO)),
    Math.floor(nodeHeight - 4),
  );
  if (fits < minFont) return null;

  if (isCompact) return Math.min(fits, maxFont);

  // Wide viewports keep the original, more conservative gate and area-derived
  // sizing — this change is about making small screens legible, not about
  // crowding the desktop map with new labels.
  if (nodeWidth <= 60 || nodeHeight <= 32) return null;
  const desired = clamp(
    minFont,
    Math.floor(Math.min(nodeWidth, nodeHeight) / 4.8),
    maxFont,
  );
  return Math.min(desired, fits);
}
