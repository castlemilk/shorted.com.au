/**
 * The net change of a window's notices (spec 14.1, backlog C1): the sum of each notice's own change in points.
 * It is printed only when every notice of the window is in the rows and every row states its change; a row with
 * no change drops the whole net, and a partial page has no net for the window (its sum would not be the window's).
 *
 * The rows carry the change as a number of points (`changePp`), the difference the grid itself sums, so the
 * net here is the net the grid draws. A row without the field, or with a null, is one that states no change.
 */

import { formatPointChange } from "~/@/lib/ownership/kinds";

/** A notice's own change in points, from a row that may carry it (`changePp`); null when it states none. */
export function changePpOf(row: object): number | null {
  if (!("changePp" in row)) return null;
  const value = row.changePp;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The window's net change as the rail prints it ("+4.20 pp"), or undefined when it cannot be summed. */
export function windowNetText(rows: readonly object[], total: number): string | undefined {
  if (rows.length === 0 || rows.length !== total) return undefined;
  let sum = 0;
  for (const row of rows) {
    const change = changePpOf(row);
    if (change === null) return undefined;
    sum += change;
  }
  return formatPointChange(0, sum);
}
