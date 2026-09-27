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
  PICK_STATUSES,
  type PickRow,
  type PickStatus,
} from "~/@/lib/strategies/types";
import { PicksTable, type RuleColumn } from "./picks-table";

/**
 * Status chips + the ranked table for one status (null = the shortlist).
 *
 * Props-only and hook-free. The page renders it directly as the <Suspense>
 * fallback with `status={null}`, so the shortlist table is in the static HTML;
 * the client island renders the same component with the `?status=` it reads.
 * The chips are real links (each filter is a URL), so the filter also works
 * before hydration. They are nofollow: every ?status= URL serves the same
 * static HTML under the page's canonical, so following them only spends crawl
 * budget.
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

export function PicksFilterView({
  rows,
  totalCount,
  rules,
  basePath,
  caption,
  status,
}: PicksFilterViewProps) {
  const counts = countByStatus(rows, totalCount);
  const visible = rowsForStatus(rows, status);
  const filled = status === null && visible.some((row) => row.status === "watch");

  let summary: string;
  if (status === null) {
    summary = `Showing ${visible.length} of ${formatCount(Math.max(totalCount, rows.length))} ranked stocks. Triggered and setup first${
      filled ? `; watch names fill the list to ${SHORTLIST_MIN_ROWS}` : ""
    }.`;
  } else {
    const count = formatStatusCount(counts[status]);
    summary = `${count} ${STATUS_LABELS[status].toLowerCase()}: ${STATUS_DESCRIPTIONS[status]}${
      counts[status].atLeast ? ` Showing those within the top ${rows.length}.` : ""
    }`;
  }

  return (
    <div className="space-y-3">
      <nav aria-label="Filter picks by status" className="flex flex-wrap gap-2">
        <Chip href={basePath} active={status === null} label="Shortlist" />
        {PICK_STATUSES.map((value) => (
          <Chip
            key={value}
            href={`${basePath}?status=${value}`}
            active={status === value}
            label={STATUS_LABELS[value]}
            count={formatStatusCount(counts[value])}
          />
        ))}
      </nav>
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {summary}
      </p>
      <PicksTable
        rows={visible}
        rules={rules}
        caption={caption}
        emptyMessage={
          status
            ? `No stocks are at ${STATUS_LABELS[status].toLowerCase()} status today.`
            : undefined
        }
      />
    </div>
  );
}
