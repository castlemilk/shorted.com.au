// Row selection and counting for the picks table and the hub cards. Pure,
// serialisable-in / serialisable-out, safe on both sides of the RSC boundary.

import {
  PICK_STATUSES,
  type PickRow,
  type PickStatus,
  type StatusCountsView,
} from "./types";

/**
 * The most rows the shortlist renders: the anonymous public depth (the API's
 * STRATEGY_PUBLIC_SIGNALS_LIMIT, 10 in production), so the Overview shows what
 * an anonymous caller can read from the API. Every row is rendered THREE times
 * on its way to a reader (the HTML, the RSC tree of the Suspense fallback, and
 * the sort island's props), each with a fundamentals disclosure, so the list
 * is bounded here as well: measured 2026-10-07, /strategies/minervini-trend-
 * template served 100 rows as 1.85 MB of HTML (115 KB gzipped). The rest of a
 * status is on the Signals tab, which carries signed-in depth, and in the API
 * for any caller with the depth.
 */
export const SHORTLIST_MAX_ROWS = 10;

/**
 * The rows shown with no ?status= filter (Zanger's "concentrate" rule, plan §1,
 * rule 5: the table is a short list). Triggered and setup rows come first, then
 * watch rows fill the table up to SHORTLIST_MAX_ROWS, so a quiet day still shows
 * the nearest candidates instead of an empty page.
 */
export function shortlistRows(rows: PickRow[]): PickRow[] {
  const ordered = [
    ...rows.filter((row) => row.status !== "watch"),
    ...rows.filter((row) => row.status === "watch"),
  ];
  return ordered.slice(0, SHORTLIST_MAX_ROWS);
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

/**
 * The per-status counts a page prints: the API's status_counts when it sent
 * them (exact over every ranked row, so a clamped row list does not shrink
 * them), otherwise the count of the rows the page holds.
 */
export function statusCountsOf(picks: {
  picks: PickRow[];
  totalCount: number;
  statusCounts?: StatusCountsView;
}): Record<PickStatus, StatusCount> {
  const api = picks.statusCounts;
  if (!api) return countByStatus(picks.picks, picks.totalCount);
  return {
    triggered: { count: api.triggered, atLeast: false },
    setup: { count: api.setup, atLeast: false },
    unknown: { count: api.unknown, atLeast: false },
    watch: { count: api.watch, atLeast: false },
  };
}

/** "12", or "100+" when the count is a floor. */
export function formatStatusCount({ count, atLeast }: StatusCount): string {
  return atLeast ? `${count}+` : String(count);
}

export const STATUS_LABELS: Record<PickStatus, string> = {
  triggered: "Triggered",
  setup: "Setup",
  unknown: "Unknown",
  watch: "Watch",
};

export const STATUS_DESCRIPTIONS: Record<PickStatus, string> = {
  triggered: "Every core rule passes.",
  setup: "Every core rule passes except the trigger, which has not happened yet.",
  unknown:
    "No core rule other than the trigger fails, and at least one core rule cannot be tested yet, so the stock may still qualify.",
  watch: "Some rules pass; ranked below the setups.",
};
