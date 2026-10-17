/**
 * The room a value axis needs beside the plot.
 *
 * An axis prints its labels in the margin, and the svg clips whatever falls
 * outside it. Between the plot and a label there is the tick (8px, visx's
 * default) and the label's own 2px offset from the tick's end, so a label has
 * to fit in the margin less 10px. How wide a label is follows its value, not
 * the chart: a price of $100 or more is seven characters, one more than a price
 * under $100, and the 48px these were given began "$140.00" about 4px outside
 * the svg and cut off its "$1".
 *
 * The margin sets the width of the plot, so it has to be known before there is
 * a plot to measure. It is estimated from the labels' characters instead, and
 * never from the DOM. The estimate is only as good as the face, so it is a
 * constant for one: the tick labels are the 10px mono face (IBM Plex Mono, and
 * the mono faces the stack falls back to, set 0.6em a character: 6px).
 */

/** Ticks asked of a full-size value axis. */
export const AXIS_NUM_TICKS = 4;
/** The tick's length: visx's default, set explicitly so the estimate cannot drift from it. */
export const AXIS_TICK_PX = 8;
/** How far the label's near edge sits from the end of its tick (`dx` in the tick label props). */
export const AXIS_LABEL_DX_PX = 2;
/** The tick labels' font size, full-size chart. */
export const AXIS_FONT_PX = 10;
/**
 * One character of the 10px mono tick label. The face sets 6.0; the estimate is a
 * little over, so a rounding in the browser's layout never costs a pixel.
 */
export const AXIS_CHAR_PX = 6.1;
/** What a side gets however short its labels are: room for six characters, "$99.99" or "12.00%". */
export const AXIS_MIN_MARGIN_PX = 48;

/**
 * The margin beside the plot for an axis that prints `labels`: the room of the
 * widest, or the 48px every side has, whichever is more.
 */
export function axisMargin(labels: readonly string[]): number {
  let chars = 0;
  for (const label of labels) if (label.length > chars) chars = label.length;
  return Math.max(
    AXIS_MIN_MARGIN_PX,
    Math.ceil(chars * AXIS_CHAR_PX) + AXIS_TICK_PX + AXIS_LABEL_DX_PX,
  );
}
