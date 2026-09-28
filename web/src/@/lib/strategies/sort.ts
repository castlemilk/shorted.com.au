// Sorting the picks table by a fundamentals figure (docs/plans/fundamentals-
// coverage.md §5.2, §7.2). Pure, serialisable in and out, no imports beyond
// types: safe on both sides of the RSC boundary.
//
// The API sorts (GetStrategyPicks sort_by). This module holds the web's half:
// the closed set of keys a URL may carry, their labels, and ONE comparator that
// mirrors services/shorts/internal/strategies/sort.go exactly, used only when
// an older API ignores sort_by and answers in rank order.

import type { PickRow } from "./types";

/** GetStrategyPicks sort_by values the page offers ("score" is the default rank order). */
export type PickSortKey =
  | "revenue_yoy"
  | "eps_yoy"
  | "roe"
  | "net_margin"
  | "fcf_margin"
  | "pe"
  | "market_cap";

/** The rows the API returned for one sort within one status. */
export interface SortedPicks {
  /** At most 100, in the sort's order; rank stays the evaluator's. */
  rows: PickRow[];
  /** Picks in the status (all picks without one), before the row limit. */
  totalCount: number;
  /**
   * The API answered in rank order (it predates sort_by), so the rows were
   * sorted here: they are the top of the rank order, sorted.
   */
  clientSorted: boolean;
}

export interface PickSortDef {
  key: PickSortKey;
  /** Chip label, and the header of the added "Sorted by" column. */
  label: string;
  /** "Top 100 of N by <phrase>". */
  phrase: string;
  /** Header tooltip for the added column. */
  title: string;
  /** Lowest first (P/E); every other key sorts highest first. */
  ascending: boolean;
  /** The table already has a column for it (Rev YoY, EPS YoY). */
  hasColumn: boolean;
}

/** Display order of the sort chips. */
export const PICK_SORTS: readonly PickSortDef[] = [
  {
    key: "revenue_yoy",
    label: "Rev YoY",
    phrase: "revenue growth",
    title: "Revenue growth on a year earlier",
    ascending: false,
    hasColumn: true,
  },
  {
    key: "eps_yoy",
    label: "EPS YoY",
    phrase: "EPS growth",
    title: "Earnings per share growth on a year earlier",
    ascending: false,
    hasColumn: true,
  },
  {
    key: "roe",
    label: "ROE",
    phrase: "ROE",
    title:
      "Return on equity: net profit over average shareholders' equity, in the reporting currency",
    ascending: false,
    hasColumn: false,
  },
  {
    key: "net_margin",
    label: "Net margin",
    phrase: "net margin",
    title: "Net profit as a share of revenue, same period",
    ascending: false,
    hasColumn: false,
  },
  {
    key: "fcf_margin",
    label: "FCF margin",
    phrase: "FCF margin",
    title:
      "Free cash flow (operating cash flow less capital expenditure) as a share of revenue",
    ascending: false,
    hasColumn: false,
  },
  {
    key: "pe",
    label: "P/E",
    phrase: "P/E, lowest first",
    title:
      "Latest close over 12-month earnings per share; AUD reporters with positive earnings only",
    ascending: true,
    hasColumn: false,
  },
  {
    key: "market_cap",
    label: "Market cap",
    phrase: "market cap",
    // The API sorts by ResolvedMarketCap: our own close x shares, or the
    // screener's figure where no share count is held (valuation_note
    // "no-shares"). The tooltip names both, so it describes what is sorted.
    title:
      "Latest close x shares on issue, in AUD; the screener's figure where we hold no share count",
    ascending: false,
    hasColumn: false,
  },
];

const BY_KEY: ReadonlyMap<string, PickSortDef> = new Map(
  PICK_SORTS.map((def) => [def.key, def]),
);

/** The definition of a sort key. */
export function pickSortDef(key: PickSortKey): PickSortDef {
  return BY_KEY.get(key)!;
}

/**
 * Parse a ?sort= value. "score" (the default rank order), an empty value and
 * anything unrecognised all mean "no sort": the server-rendered rows as they
 * are.
 */
export function parsePickSort(
  value: string | null | undefined,
): PickSortKey | null {
  const normalised = (value ?? "").trim().toLowerCase();
  return BY_KEY.has(normalised) ? (normalised as PickSortKey) : null;
}

/** The query string for a status filter and a sort, "" when both are defaults. */
export function picksQuery(
  status: string | null,
  sort: PickSortKey | null,
): string {
  const params: string[] = [];
  if (status) params.push(`status=${encodeURIComponent(status)}`);
  if (sort) params.push(`sort=${encodeURIComponent(sort)}`);
  return params.length > 0 ? `?${params.join("&")}` : "";
}

// Mirrors sort.go: growth outside [-95%, +500%] is a real number but not a
// comparable one, so it sorts after every measured figure and before unknowns.
const GROWTH_CEILING_PCT = 500;
const GROWTH_FLOOR_PCT = -95;

const MEASURED = 0;
const OUT_OF_RANGE = 1;
const UNKNOWN = 2;

/** The figure a row sorts on, null when it has none. */
export function pickSortValue(row: PickRow, key: PickSortKey): number | null {
  const f = row.fundamentals;
  let value: number | null | undefined;
  switch (key) {
    case "revenue_yoy":
      value = row.revenueYoyPct;
      break;
    case "eps_yoy":
      value = row.epsYoyPct;
      break;
    case "roe":
      value = f?.roePct;
      break;
    case "net_margin":
      value = f?.netMarginPct;
      break;
    case "fcf_margin":
      value = f?.fcfMarginPct;
      break;
    case "pe":
      value = f?.peRatio;
      break;
    case "market_cap":
      value = row.marketCap;
      break;
  }
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function bucket(value: number | null, key: PickSortKey): number {
  if (value === null) return UNKNOWN;
  if (
    (key === "revenue_yoy" || key === "eps_yoy") &&
    (value > GROWTH_CEILING_PCT || value < GROWTH_FLOOR_PCT)
  ) {
    return OUT_OF_RANGE;
  }
  return MEASURED;
}

/**
 * A sorted COPY of rows, the API's order exactly: measured figures (highest
 * first, P/E lowest first), then out-of-range growth, then unknowns; ties and
 * every row in the last two groups keep their input order (a stable sort over
 * a rank-ordered input). Never mutates `rows`.
 */
export function sortPickRows(
  rows: readonly PickRow[],
  key: PickSortKey,
): PickRow[] {
  const ascending = pickSortDef(key).ascending;
  const keyed = rows.map((row, index) => {
    const value = pickSortValue(row, key);
    return { row, index, value, bucket: bucket(value, key) };
  });
  keyed.sort((a, b) => {
    if (a.bucket !== b.bucket) return a.bucket - b.bucket;
    if (a.bucket === MEASURED && a.value !== b.value) {
      // Both are measured, so neither is null here.
      const diff = (a.value ?? 0) - (b.value ?? 0);
      return ascending ? diff : -diff;
    }
    return a.index - b.index;
  });
  return keyed.map((entry) => entry.row);
}

/**
 * True when rows are in the evaluator's rank order: what an API that
 * predates sort_by returns whatever it is asked. Also true when a real sort
 * happens to coincide with rank order (every figure unknown, say), and then
 * sorting again changes nothing.
 */
export function isRankOrder(rows: readonly PickRow[]): boolean {
  for (let i = 1; i < rows.length; i++) {
    if (rows[i - 1]!.rank >= rows[i]!.rank) return false;
  }
  return true;
}
