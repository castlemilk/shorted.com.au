/**
 * The index fund window's change lists (spec 13.5): the rises, falls, new and
 * dropped stocks across the tracked funds. Pure, and kept apart from the sankey's
 * layout so the fund island's chunk does not carry d3-sankey.
 */

/* ------------------------------------------------------------------ */
/* The fund window's list (spec 13.5)                                 */
/* ------------------------------------------------------------------ */

export type FundChangeState = "current" | "new" | "dropped";

/** One stock across the tracked index funds, as the loader maps it. */
export interface FundChangeRow {
  code: string;
  name: string;
  weightFrom: number | null;
  weightTo: number | null;
  /** Percentage points of weight, to less from. Null when the stock is held on one date only. */
  delta: number | null;
  valueFrom: number | null;
  valueTo: number | null;
  funds: number;
  state: FundChangeState;
}

export interface FundChangeLists {
  /** Largest rise first. */
  rises: FundChangeRow[];
  /** Largest fall first. */
  falls: FundChangeRow[];
  /** Held on the newer date only, largest weight first. */
  added: FundChangeRow[];
  /** Held on the older date only, largest weight first. */
  dropped: FundChangeRow[];
}

/** The most rows a list may show, and the default when none is asked for. */
const LIST_MAX = 50;
const LIST_DEFAULT = 10;

function byCode(a: FundChangeRow, b: FundChangeRow): number {
  return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
}

/**
 * The fund window's four lists. A stock is in a change list only when it has a
 * delta, so a stock that is new or dropped is never counted as a change from zero,
 * and one whose weight did not move is in neither. The API already sorts the rows;
 * the sort here keeps the lists right when the caller's order is not.
 */
export function partitionFundChanges(
  rows: readonly FundChangeRow[],
  limit: number = LIST_DEFAULT,
): FundChangeLists {
  const cap = Number.isFinite(limit) && limit > 0 ? Math.min(Math.trunc(limit), LIST_MAX) : LIST_DEFAULT;
  const rises: FundChangeRow[] = [];
  const falls: FundChangeRow[] = [];
  const added: FundChangeRow[] = [];
  const dropped: FundChangeRow[] = [];
  for (const row of rows) {
    if (row.state === "new") added.push(row);
    else if (row.state === "dropped") dropped.push(row);
    else if (row.delta !== null && row.delta > 0) rises.push(row);
    else if (row.delta !== null && row.delta < 0) falls.push(row);
  }
  rises.sort((a, b) => b.delta! - a.delta! || byCode(a, b));
  falls.sort((a, b) => a.delta! - b.delta! || byCode(a, b));
  added.sort((a, b) => (b.weightTo ?? 0) - (a.weightTo ?? 0) || byCode(a, b));
  dropped.sort((a, b) => (b.weightFrom ?? 0) - (a.weightFrom ?? 0) || byCode(a, b));
  return {
    rises: rises.slice(0, cap),
    falls: falls.slice(0, cap),
    added: added.slice(0, cap),
    dropped: dropped.slice(0, cap),
  };
}
