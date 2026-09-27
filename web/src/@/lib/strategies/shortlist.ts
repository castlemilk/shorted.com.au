// Row selection and counting for the picks table and the hub cards. Pure,
// serialisable-in / serialisable-out, safe on both sides of the RSC boundary.

import { PICK_STATUSES, type PickRow, type PickStatus } from "./types";

/**
 * Zanger's "concentrate" rule (plan §1, rule 5): the table is a short list.
 * Triggered and setup rows always show; watch rows only fill the table up to
 * this many rows, so a quiet day still shows the nearest candidates instead of
 * an empty page, and a busy day is not padded with near-misses.
 */
export const SHORTLIST_MIN_ROWS = 20;

/** The rows shown with no ?status= filter. */
export function shortlistRows(rows: PickRow[]): PickRow[] {
  const primary = rows.filter((row) => row.status !== "watch");
  if (primary.length >= SHORTLIST_MIN_ROWS) return primary;
  const fill = rows
    .filter((row) => row.status === "watch")
    .slice(0, SHORTLIST_MIN_ROWS - primary.length);
  return [...primary, ...fill];
}

/** The rows for a given filter: null is the shortlist. */
export function rowsForStatus(
  rows: PickRow[],
  status: PickStatus | null,
): PickRow[] {
  return status ? rows.filter((row) => row.status === status) : shortlistRows(rows);
}

/** Parse a ?status= value; anything unrecognised is the shortlist. */
export function parsePickStatus(value: string | null | undefined): PickStatus | null {
  const normalised = (value ?? "").trim().toLowerCase();
  return (PICK_STATUSES as readonly string[]).includes(normalised)
    ? (normalised as PickStatus)
    : null;
}

export interface StatusCount {
  count: number;
  /**
   * True when the row limit cut this status off, so `count` is a floor. Rows
   * are ranked status first, so only the status of the LAST fetched row can be
   * truncated; every status before it is complete.
   */
  atLeast: boolean;
}

export function countByStatus(
  rows: PickRow[],
  totalCount: number,
): Record<PickStatus, StatusCount> {
  const truncated = totalCount > rows.length;
  const lastStatus = rows.length > 0 ? rows[rows.length - 1]!.status : null;
  const result = {} as Record<PickStatus, StatusCount>;
  for (const status of PICK_STATUSES) {
    const count = rows.filter((row) => row.status === status).length;
    const lastIndex = lastStatus ? PICK_STATUSES.indexOf(lastStatus) : -1;
    const statusIndex = PICK_STATUSES.indexOf(status);
    result[status] = {
      count,
      // The truncated status and every status ranked after it are unknown
      // beyond what was fetched.
      atLeast: truncated && statusIndex >= lastIndex,
    };
  }
  return result;
}

/** "12", or "100+" when the count is a floor. */
export function formatStatusCount({ count, atLeast }: StatusCount): string {
  return atLeast ? `${count}+` : String(count);
}

export const STATUS_LABELS: Record<PickStatus, string> = {
  triggered: "Triggered",
  setup: "Setup",
  watch: "Watch",
};

export const STATUS_DESCRIPTIONS: Record<PickStatus, string> = {
  triggered: "Every core rule passes.",
  setup: "Every core rule passes except the trigger, which has not happened yet.",
  watch: "Some rules pass; ranked below the setups.",
};
