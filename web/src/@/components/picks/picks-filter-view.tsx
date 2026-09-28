import Link from "next/link";

import { cn } from "~/@/lib/utils";
import { formatCount } from "~/@/lib/strategies/format";
import {
  SHORTLIST_MIN_ROWS,
  STATUS_DESCRIPTIONS,
  STATUS_LABELS,
  countByStatus,
  formatStatusCount,
  rowsForStatus,
} from "~/@/lib/strategies/shortlist";
import {
  PICK_SORTS,
  pickSortDef,
  picksQuery,
  type PickSortKey,
  type SortedPicks,
} from "~/@/lib/strategies/sort";
import {
  PICK_STATUSES,
  type PickRow,
  type PickStatus,
} from "~/@/lib/strategies/types";
import { ProvenanceLegend } from "~/@/components/stocks/provenance";
import { FILING_SOURCE, rowsShowFilingMark } from "./pick-fundamentals";
import { PicksTable, type RuleColumn } from "./picks-table";

/**
 * Status chips, sort chips and the ranked table for one status (null = the
 * shortlist), optionally sorted by a fundamentals figure.
 *
 * Props-only and hook-free. The page renders it directly as the <Suspense>
 * fallback with `status={null}` and no sort, so the shortlist table is in the
 * static HTML; the sort island (app/picks/[strategy]/picks-sorted-view.tsx)
 * renders the same component with the `?status=` and `?sort=` it reads and,
 * once the API has answered, the sorted rows. The chips are real links (each
 * filter and each sort is a URL), so they also work before hydration. They
 * are nofollow: every query URL serves the same static HTML under the page's
 * canonical, so following them only spends crawl budget.
 */
export interface PicksFilterViewProps {
  /** Every fetched row (max 100), ranked. */
  rows: PickRow[];
  /** Every ranked pick, before the row limit. */
  totalCount: number;
  rules: RuleColumn[];
  /** The page path the chips link to, e.g. "/picks/zanger-breakout". */
  basePath: string;
  caption: string;
  status: PickStatus | null;
  /** See PicksTableProps.showFundamentals. */
  showFundamentals?: boolean;
  /** The ?sort= in effect; null (or absent) is the default rank order. */
  sort?: PickSortKey | null;
  /** The API's answer for `sort` within `status`; absent until it arrives. */
  sorted?: SortedPicks | null;
  /** The sorted rows are loading, or could not be loaded. */
  sortPhase?: "loading" | "error" | null;
  /**
   * Called when a reader reaches for a sort chip (pointer or focus), so the
   * island can start loading its fetch code before the click. Never passed
   * by the server page.
   */
  onSortIntent?: () => void;
}

function Chip({
  href,
  active,
  label,
  count,
}: {
  href: string;
  active: boolean;
  label: string;
  count?: string;
}) {
  return (
    <Link
      href={href}
      replace
      scroll={false}
      prefetch={false}
      rel="nofollow"
      aria-current={active ? "true" : undefined}
      className={cn(
        "inline-flex h-9 items-center gap-2 rounded-md border px-3 text-xs transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        active
          ? "border-primary/60 bg-primary/10 font-semibold text-primary"
          : "border-border text-muted-foreground hover:border-input hover:text-foreground",
      )}
    >
      {label}
      {count !== undefined ? <span className="tabular-nums">{count}</span> : null}
    </Link>
  );
}

/** "Top 100 of 1,904 by ROE." and what the order means. */
export function sortedSummary(
  sorted: SortedPicks,
  sort: PickSortKey,
  status: PickStatus | null,
): string {
  const def = pickSortDef(sort);
  const shown = sorted.rows.length;
  const total = Math.max(sorted.totalCount, shown);
  const scope = status ? ` ${STATUS_LABELS[status]} stocks only.` : "";
  // An older API answers in rank order whatever it is asked; the rows it
  // sent were sorted here, so when it sent fewer than it ranked, they are the
  // top of the RANK order, not of the metric.
  if (sorted.clientSorted && shown < total) {
    return `The first ${formatCount(shown)} of ${formatCount(total)} by rank, sorted by ${def.phrase}.${scope}`;
  }
  return `Top ${formatCount(shown)} of ${formatCount(total)} by ${def.phrase}.${scope} Stocks without the figure come last.`;
}

export function PicksFilterView({
  rows,
  totalCount,
  rules,
  basePath,
  caption,
  status,
  showFundamentals = false,
  sort = null,
  sorted = null,
  sortPhase = null,
  onSortIntent,
}: PicksFilterViewProps) {
  const counts = countByStatus(rows, totalCount);
  const sortedRows = sort && sorted ? sorted.rows : null;
  // With a sort the API returns every stock in the status (no shortlist):
  // sorting applies within the selected status. Until it answers, the rows
  // the server rendered stand in, dimmed.
  const visible = sortedRows ?? rowsForStatus(rows, status);
  const filled =
    sortedRows === null &&
    status === null &&
    visible.some((row) => row.status === "watch");

  let summary: string;
  if (sort && sorted) {
    summary = sortedSummary(sorted, sort, status);
  } else if (status === null) {
    summary = `Showing ${visible.length} of ${formatCount(Math.max(totalCount, rows.length))} ranked stocks. Triggered and setup first${
      filled ? `; watch names fill the list to ${SHORTLIST_MIN_ROWS}` : ""
    }.`;
  } else {
    const count = formatStatusCount(counts[status]);
    summary = `${count} ${STATUS_LABELS[status].toLowerCase()}: ${STATUS_DESCRIPTIONS[status]}${
      counts[status].atLeast ? ` Showing those within the top ${rows.length}.` : ""
    }`;
  }
  const busy = Boolean(sort) && !sorted && sortPhase === "loading";
  const unavailable = Boolean(sort) && !sorted && sortPhase === "error";
  if (busy) summary = `Sorting by ${pickSortDef(sort!).phrase}. ${summary}`;

  return (
    <div className="space-y-3">
      <nav aria-label="Filter picks by status" className="flex flex-wrap gap-2">
        <Chip href={`${basePath}${picksQuery(null, sort)}`} active={status === null} label="Shortlist" />
        {PICK_STATUSES.map((value) => (
          <Chip
            key={value}
            href={`${basePath}${picksQuery(value, sort)}`}
            active={status === value}
            label={STATUS_LABELS[value]}
            count={formatStatusCount(counts[value])}
          />
        ))}
      </nav>
      <nav
        aria-label="Sort picks"
        className="flex flex-wrap items-center gap-2"
        onPointerEnter={onSortIntent}
        onFocus={onSortIntent}
      >
        <span className="text-xs text-muted-foreground">Sort by</span>
        <Chip href={`${basePath}${picksQuery(status, null)}`} active={sort === null} label="Rank" />
        {PICK_SORTS.map((def) => (
          <Chip
            key={def.key}
            href={`${basePath}${picksQuery(status, def.key)}`}
            active={sort === def.key}
            label={def.label}
          />
        ))}
      </nav>
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {unavailable ? (
          <>
            <span className="font-medium text-foreground">
              Sorting is unavailable right now.
            </span>{" "}
          </>
        ) : null}
        {summary}
      </p>
      <PicksTable
        rows={visible}
        rules={rules}
        caption={caption}
        showFundamentals={showFundamentals}
        sortKey={sortedRows ? sort : null}
        busy={busy}
        emptyMessage={
          status
            ? `No stocks are at ${STATUS_LABELS[status].toLowerCase()} status today.`
            : undefined
        }
      />
      {rowsShowFilingMark(visible) ? (
        <ProvenanceLegend sources={[FILING_SOURCE]} />
      ) : null}
    </div>
  );
}
