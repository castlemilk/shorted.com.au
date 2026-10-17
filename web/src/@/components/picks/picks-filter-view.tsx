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
  type StatusCount,
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
 * once the API has answered, the fetched rows. The chips are real links (each
 * filter and each sort is a URL), so they also work before hydration. They
 * are nofollow: every query URL serves the same static HTML under the page's
 * canonical, so following them only spends crawl budget.
 *
 * `rows` is the SHORTLIST (shortlistRows, at most SHORTLIST_MAX_ROWS), not
 * every ranked row: a status filter is answered by the API, like a sort,
 * and until it answers the shortlist's rows of that status stand in. The
 * chip counts over every ranked row come from `counts`, computed once on the
 * server, so the island never has to carry the whole list to label a chip.
 */
export interface PicksFilterViewProps {
  /** The shortlist rows the server rendered, ranked. */
  rows: PickRow[];
  /** Every ranked pick, before the row limit. */
  totalCount: number;
  /**
   * Status counts over every ranked row the server fetched (up to the API's
   * 100). Computed from `rows` when absent, which is only right when `rows`
   * is the whole list.
   */
  counts?: Record<PickStatus, StatusCount>;
  rules: RuleColumn[];
  /** The page path the chips link to, e.g. "/picks/zanger-breakout". */
  basePath: string;
  caption: string;
  status: PickStatus | null;
  /** See PicksTableProps.showFundamentals. */
  showFundamentals?: boolean;
  /** The ?sort= in effect; null (or absent) is the default rank order. */
  sort?: PickSortKey | null;
  /** The API's answer for `status` and `sort`; absent until it arrives. */
  sorted?: SortedPicks | null;
  /** The fetched rows are loading, or could not be loaded. */
  sortPhase?: "loading" | "error" | null;
  /**
   * Called when a reader reaches for a status or sort chip (pointer or
   * focus), so the island can start loading its fetch code before the click.
   * Never passed by the server page.
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
        "inline-flex h-9 items-center gap-2 rounded-md border px-3 text-xs transition-colors duration-150 motion-reduce:transition-none",
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

/** "12 setup: every core rule passes except the trigger." */
function statusSummary(count: string, status: PickStatus): string {
  return `${count} ${STATUS_LABELS[status].toLowerCase()}: ${STATUS_DESCRIPTIONS[status]}`;
}

export function PicksFilterView({
  rows,
  totalCount,
  counts: countsProp,
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
  const counts = countsProp ?? countByStatus(rows, totalCount);
  const asked = sort !== null || status !== null;
  const fetchedRows = asked && sorted ? sorted.rows : null;
  // A sort or a status filter is the API's answer. Until it arrives, the
  // shortlist's rows of that status stand in, dimmed.
  const visible = fetchedRows ?? rowsForStatus(rows, status);
  const filled =
    fetchedRows === null &&
    status === null &&
    visible.some((row) => row.status === "watch");

  let summary: string;
  if (sort && sorted) {
    summary = sortedSummary(sorted, sort, status);
  } else if (status && sorted) {
    const total = Math.max(sorted.totalCount, sorted.rows.length);
    summary =
      statusSummary(formatCount(total), status) +
      (sorted.rows.length < total
        ? ` Showing the top ${formatCount(sorted.rows.length)}.`
        : "");
  } else if (status === null) {
    const total = formatCount(Math.max(totalCount, rows.length));
    summary = `Showing ${visible.length} of ${total} ranked stocks. Triggered and setup first${
      filled ? `; watch names fill the list to ${SHORTLIST_MIN_ROWS}` : ""
    }.`;
  } else {
    summary = statusSummary(formatStatusCount(counts[status]), status);
  }
  const busy = asked && !sorted && sortPhase === "loading";
  const unavailable = asked && !sorted && sortPhase === "error";
  if (busy) {
    summary = sort
      ? `Sorting by ${pickSortDef(sort).phrase}. ${summary}`
      : `Loading every ${STATUS_LABELS[status!].toLowerCase()} stock. ${summary}`;
  }
  const statusWord = status ? STATUS_LABELS[status].toLowerCase() : "";

  return (
    <div className="space-y-3">
      <nav
        aria-label="Filter picks by status"
        className="flex flex-wrap gap-2"
        onPointerEnter={onSortIntent}
        onFocus={onSortIntent}
      >
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
              {sort
                ? "Sorting is unavailable right now."
                : `The full ${statusWord} list is unavailable right now.`}
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
        sortKey={fetchedRows && sort ? sort : null}
        busy={busy}
        emptyMessage={
          status
            ? busy
              ? `Loading ${statusWord} stocks.`
              : unavailable
                ? `The full ${statusWord} list is unavailable right now.`
                : `No stocks are at ${statusWord} status today.`
            : undefined
        }
      />
      {rowsShowFilingMark(visible) ? (
        <ProvenanceLegend sources={[FILING_SOURCE]} />
      ) : null}
    </div>
  );
}
