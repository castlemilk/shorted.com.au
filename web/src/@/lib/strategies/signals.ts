// The Signals tab's rules: how many rows an anonymous visitor sees, which rules
// the matrix draws as columns, the ranking inputs each strategy prints beside
// them, and the count line and filter chips that read the API's status counts.
//
// Pure and serialisable, so the page, the island and the tests share one list.

import { NOT_AVAILABLE, formatSigned } from "~/@/lib/strategies/format";
import type {
  PickRow,
  PickStatus,
  StatusCountsView,
  StrategyRuleDef,
} from "~/@/lib/strategies/types";

/** The rows an anonymous visitor sees; the rest of the list is a count. */
export const SIGNALS_PUBLIC_ROWS = 10;

/** A rule as the Signals matrix needs it: the definition's fields, nothing else. */
export type SignalRule = Pick<
  StrategyRuleDef,
  | "id"
  | "title"
  | "core"
  | "trigger"
  | "evaluation"
  | "threshold"
  | "unit"
  | "comparator"
>;

/** The status chips, in display order. "all" is every signal. */
export type SignalFilter = "all" | PickStatus | "unknown";

/** One column of the scoring inputs a strategy prints after its core rules. */
export interface RankingInput {
  id: string;
  /** The column's head, with the asterisk the footnote explains. */
  label: string;
  title: string;
  read: (row: PickRow) => string;
}

/** A percentile in whole points, floored so a value under the line never reads at it. */
export function formatPercentile(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return NOT_AVAILABLE;
  return Math.floor(value).toString();
}

/** Days to cover as one decimal; "n/a" when the API holds none. */
function formatDays(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0)
    return NOT_AVAILABLE;
  return value.toFixed(1);
}

const RANKING_DAYS_TO_COVER: RankingInput = {
  id: "days_to_cover",
  label: "Days to cover*",
  title: "Short position over average daily volume, in days",
  read: (row) => formatDays(row.daysToCover ?? null),
};

const RANKING_RS_3M: RankingInput = {
  id: "rs_3m",
  label: "3m RS*",
  title: "Stock return minus the index return over 3 months, in points",
  read: (row) => formatSigned(row.rs3mPct, "pp"),
};

const RANKING_RS_6M_PERCENTILE: RankingInput = {
  id: "rs_6m_percentile",
  label: "6m RS pctl*",
  title:
    "Rank of the 6-month relative strength across the universe, 0 to 100; 75 or more is the top quartile",
  // Floored, not rounded: 74.6 must not print as 75, the top-quartile line.
  read: (row) => formatPercentile(row.rs6mPercentile ?? null),
};

/**
 * The scoring inputs each strategy shows beside its core rules. A strategy
 * not listed shows none. Market direction is a list-level fact, so no column.
 */
export const RANKING_INPUTS: Readonly<Record<string, readonly RankingInput[]>> =
  {
    "crowded-short-breakout": [RANKING_DAYS_TO_COVER, RANKING_RS_3M],
    canslim: [RANKING_RS_6M_PERCENTILE],
    "minervini-trend-template": [RANKING_RS_6M_PERCENTILE],
  };

export function rankingInputsFor(slug: string): readonly RankingInput[] {
  return RANKING_INPUTS[slug] ?? [];
}

/** The rules that must pass for "triggered": one matrix column each. */
export function coreRules<T extends { core: boolean }>(
  rules: readonly T[],
): T[] {
  return rules.filter((rule) => rule.core);
}

/** The status chips to draw: Unknown only once the API counts an unknown signal. */
export function chipFilters(counts: StatusCountsView | null): SignalFilter[] {
  const chips: SignalFilter[] = ["all", "triggered", "setup", "watch"];
  if (counts && counts.unknown > 0) chips.push("unknown");
  return chips;
}

/** A filter's count from the API's status counts; null when the API sent none. */
export function filterCount(
  filter: SignalFilter,
  counts: StatusCountsView | null,
  total: number,
): number | null {
  if (filter === "all") return counts ? total : null;
  return counts ? counts[filter] : null;
}

const STATUS_ORDER: ReadonlyArray<keyof StatusCountsView> = [
  "triggered",
  "setup",
  "unknown",
  "watch",
];

/**
 * The line after the visible rows: how many are shown of the total, and the
 * whole list's split by status (non-zero parts only). "" when the API sent no
 * counts, so the line never invents a split.
 */
export function countLine(
  counts: StatusCountsView | null,
  shown: number,
  total: number,
): string {
  if (!counts) return "";
  const head =
    total > shown
      ? `Showing ${shown} of ${total} signals`
      : `${total} ${total === 1 ? "signal" : "signals"}`;
  const split = statusSplit(counts);
  return split ? `${head}: ${split}` : head;
}

/** The whole list's split by status, non-zero parts only: "5 triggered · 66 setup". "" with no counts. */
export function statusSplit(counts: StatusCountsView | null): string {
  if (!counts) return "";
  return STATUS_ORDER.filter((key) => counts[key] > 0)
    .map((key) => `${counts[key]} ${key}`)
    .join(" · ");
}

/**
 * The sign-in prompt's copy: what a free account unlocks, with the whole list's
 * size and split. The same words serve the list's last row and an inline prompt.
 */
export function signInPromptCopy(
  counts: StatusCountsView | null,
  total: number,
): string {
  const split = statusSplit(counts);
  const noun = total === 1 ? "signal" : "signals";
  return split
    ? `Sign in free to see all ${total} ${noun} (${split}).`
    : `Sign in free to see all ${total} ${noun}.`;
}

/** The status word a filter chip names, as the page prints it. */
export const FILTER_LABELS: Readonly<Record<SignalFilter, string>> = {
  all: "All",
  triggered: "Triggered",
  setup: "Setup",
  watch: "Watch",
  unknown: "Unknown",
};

/** Whether a row belongs to a filter. "all" takes every row. */
export function matchesFilter(
  row: Pick<PickRow, "status">,
  filter: SignalFilter,
): boolean {
  return filter === "all" || row.status === filter;
}

/** "stock:BHP" from `?sel=`; null for anything else. */
export function parseSelection(raw: string | null | undefined): string | null {
  const match = /^stock:([A-Za-z0-9]{1,6})$/.exec((raw ?? "").trim());
  return match ? match[1]!.toUpperCase() : null;
}
