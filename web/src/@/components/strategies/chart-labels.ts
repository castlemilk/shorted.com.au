// In-plot text labels for the backtest chart (PR-19 defect 5). The engine-change label and the
// "Recorded since" label both sit at the plot's right edge, so each label gets an estimated box
// and is stacked down rows until it clears the boxes already placed. Pure: no DOM, no measuring.

/** The chart's label size in CSS px (the SVG's text is 11px). */
export const CHART_LABEL_PX = 11;
/** The row pitch the stacked labels step by. */
export const CHART_LABEL_ROW_PX = 12;
// IBM Plex Mono advances 0.6em a character; the ascent and descent bound the glyphs.
const CHAR_PX = CHART_LABEL_PX * 0.6;
const ASCENT_PX = 9;
const DESCENT_PX = 3;
// Clearance kept around every box, so two labels read apart rather than touching.
const PAD_PX = 3;

export type LabelAnchor = "start" | "end";
export interface LabelBox {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}
export interface PlacedLabel {
  x: number;
  y: number;
  anchor: LabelAnchor;
  box: LabelBox;
}

/** The estimated box of a label whose baseline sits at (x, y). */
export function labelBox(text: string, x: number, y: number, anchor: LabelAnchor): LabelBox {
  const width = text.length * CHAR_PX;
  const left = anchor === "end" ? x - width : x;
  return {
    x0: left - PAD_PX,
    x1: left + width + PAD_PX,
    y0: y - ASCENT_PX - PAD_PX,
    y1: y + DESCENT_PX + PAD_PX,
  };
}

export function boxesOverlap(a: LabelBox, b: LabelBox): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

/**
 * The first row, from `firstY` down to `lastY` in `rowPx` steps, whose box clears every box in
 * `taken`. When no row clears, the label stays on `firstY`: a plot too short to stack in is rare,
 * and the label then reads as it did before the layout.
 */
export function placeLabel(
  text: string,
  x: number,
  anchor: LabelAnchor,
  firstY: number,
  rowPx: number,
  lastY: number,
  taken: readonly LabelBox[],
): PlacedLabel {
  for (let y = firstY; y <= lastY; y += rowPx) {
    const box = labelBox(text, x, y, anchor);
    if (!taken.some((other) => boxesOverlap(other, box))) return { x, y, anchor, box };
  }
  return { x, y: firstY, anchor, box: labelBox(text, x, firstY, anchor) };
}
