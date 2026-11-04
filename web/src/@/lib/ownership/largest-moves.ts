/**
 * The Activity inspector's largest moves (spec 14.10): the window's notices that state a change in
 * disclosed voting power, ranked by the server (GetOwnershipActivity's largest_moves: the size of the
 * stated change, then the newer release, then the stock code). This module turns the served moves
 * into the rail's lines and names the window they cover.
 *
 * A PURE MODULE. A notice that does not state both figures is never served as a move, so nothing here
 * reads a missing figure as zero.
 */

/** One served move: a notice that states both figures, with the change it states. */
export interface LargestMove {
  code: string;
  /** The holder's institution name when the register knows one, else the name the notice states. */
  holder: string;
  /** The notice on ASX; "" when the notice names none. */
  url: string;
  /** The date ASX released the notice, YYYY-MM-DD. */
  released: string;
  /** Present less previous, in percentage points, with its sign. */
  change: number;
}

/**
 * The rail's lines for the served moves: the company and holder, the stated change as the caller
 * prints it, and the notice's link ("" when it is not a safe one). `format` is the desk's pp
 * formatter, so the sign is the one every other figure carries.
 */
export function largestMoveLines(
  moves: readonly LargestMove[],
  format: (pp: number) => string,
  safeHref: (url: string) => string | undefined,
): { label: string; value: string; href: string }[] {
  return moves.map((move) => ({
    label: `${move.code} · ${move.holder}`,
    value: `${format(move.change)} · ${move.released}`,
    href: safeHref(move.url) ?? "",
  }));
}

/**
 * The days a window of whole ISO weeks spans, both ends inclusive: from the Monday of its first week
 * to the Sunday of its last. 0 when either end is not a date, or the window is inverted.
 */
export function weekSpanDays(fromWeek: string, toWeek: string): number {
  const from = Date.parse(`${fromWeek}T00:00:00Z`);
  const to = Date.parse(`${toWeek}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return 0;
  return Math.round((to - from) / 86_400_000) + 7;
}

/**
 * The days a window spans from one date to another, both ends inclusive (the window the
 * Activity rail names: its first week's Monday to the newest notice's date). 0 when either
 * end is not a date, or the window is inverted.
 */
export function inclusiveDays(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return Math.round((end - start) / 86_400_000) + 1;
}
