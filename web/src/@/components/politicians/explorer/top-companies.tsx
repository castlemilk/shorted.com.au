/**
 * The rail's "Most-declared companies" list.
 *
 * A COUNT OF PEOPLE, AND NOTHING ELSE. `politicianCount` is the number of
 * members currently declaring an interest in a company; the registers record
 * what is held and never quantity or value, so there is no amount here to show
 * and no bar to weight by size. The footnote says so on the surface rather than
 * leaving a reader to assume the column is a total of something.
 *
 * A count is not a ranking of people either: the list is ordered by whatever the
 * caller passes, the row says "12 members", and no row is called notable, heavy
 * or unusual. The reader draws the inference; we publish the count.
 *
 * PROPS-ONLY AND SERVER-SAFE. This is explorer kit: plain serialisable props, a
 * server component with no client directive, and no generated protobuf module
 * anywhere in its import graph, so a client island can compose it without
 * dragging the protobuf runtime across the boundary (client-boundary.test.ts
 * walks that transitively). Its host page owns the SourceLine and the
 * report-an-error affordance, exactly as it does for every other file here.
 */

import Link from "next/link";

import { SectionIcon } from "@/components/politicians/politics-icon";

/** One company, with the number of members declaring an interest in it. */
export interface TopCompanyRow {
  stockCode: string;
  companyName: string;
  politicianCount: number;
}

/** Defensive: a count is a whole, non-negative number of people or it is zero. */
function safeCount(count: number): number {
  return Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
}

/** "1 member", "12 members". People, stated as people. */
function memberLabel(count: number): string {
  return count === 1 ? "1 member" : `${count} members`;
}

export function TopCompanies({ stocks }: { stocks: TopCompanyRow[] }) {
  // A row with no code cannot be linked or named, so it is dropped rather than
  // rendered as a blank line beside a count.
  const rows = stocks.filter((stock) => stock.stockCode);
  // Silence, not an empty frame: a heading over nothing reads as a claim that
  // nothing is declared.
  if (rows.length === 0) return null;

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">
        <SectionIcon name="shareholdings" size="sm" />
        Most-declared companies
      </h3>
      <ul className="divide-y">
        {rows.map((row) => (
          <li key={row.stockCode}>
            <Link
              // `prefetch={false}` for the same reason the hub's roll sets it: a
              // rail of links is a directory, not a set of likely next steps,
              // and each one is an RSC payload the reader never asked for.
              href={`/shorts/${row.stockCode}`}
              prefetch={false}
              className="flex items-baseline justify-between gap-2 py-1 text-xs hover:underline"
            >
              <span className="flex min-w-0 items-baseline gap-1.5">
                <span className="font-medium">{row.stockCode}</span>
                {row.companyName ? (
                  <span className="truncate text-muted-foreground">{row.companyName}</span>
                ) : null}
              </span>
              <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground">
                {memberLabel(safeCount(row.politicianCount))}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <p className="text-[10px] text-muted-foreground">
        Counted by members declaring. Not an amount.
      </p>
    </div>
  );
}
