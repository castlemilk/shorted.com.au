import Link from "next/link";

import { cn } from "~/@/lib/utils";
import { StockLogo } from "~/@/components/reports/stock-logo";
import {
  STATUS_LABELS,
  formatStatusCount,
  type StatusCount,
} from "~/@/lib/strategies/shortlist";
import type { PickStatus } from "~/@/lib/strategies/types";
import { StatusPill } from "./picks-table";
import { StrategyGlyph } from "./strategy-glyph";

/**
 * One strategy on the /picks hub: one instrument in the rack. The rack is a
 * single hairline-divided chassis (the hub's <ol>), and each row carries the
 * bare engraved glyph at the left, who the strategy comes from and what it
 * looks for, two recessed readouts (how many stocks are triggered and set up
 * today) and a short paper tape of the first names on its list. Rows differ
 * by glyph, counts and names, not by chrome: no bezel tiles, no identical
 * icon-card grid (the anti-reference DESIGN.md names), and the one 56px
 * bezel on the desk is the strategy page's own header.
 *
 * Flat at rest; amber only as a response to hover or focus (the row takes a
 * tonal wash and the glyph lights). The whole row is clickable through a
 * stretched title link (an overlay pseudo-element), with the stock-code links
 * raised above it: wrapping the row in one anchor would nest anchors.
 */

export interface StrategyCardLeader {
  code: string;
  name: string;
  logoUrl: string;
  status: PickStatus;
}

export interface StrategyCardProps {
  slug: string;
  name: string;
  /** Empty when the API is unavailable. */
  author: string;
  tagline: string;
  /** Null when the picks could not be read. */
  counts: Record<"triggered" | "setup", StatusCount> | null;
  leaders: StrategyCardLeader[];
}

/** A recessed readout window; the number sits still. */
function Readout({
  status,
  count,
}: {
  status: "triggered" | "setup";
  count: StatusCount;
}) {
  return (
    <div className="min-w-[5.5rem] rounded-sm border border-border/60 bg-background px-3 py-2">
      <dt className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
        {STATUS_LABELS[status]}
      </dt>
      {/* A dark window when the reading is zero. */}
      <dd
        className={cn(
          "mt-1 text-2xl font-semibold leading-none tabular-nums",
          count.count === 0 ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {formatStatusCount(count)}
      </dd>
    </div>
  );
}

export function StrategyCard({
  slug,
  name,
  author,
  tagline,
  counts,
  leaders,
}: StrategyCardProps) {
  const href = `/picks/${slug}`;
  return (
    <article
      className={cn(
        "group relative grid gap-4 p-4 sm:p-5",
        "md:grid-cols-[2.5rem_minmax(0,1.3fr)_auto_minmax(0,1fr)] md:items-start md:gap-x-6",
        "transition-colors duration-200 hover:bg-muted/30 focus-within:bg-muted/30 motion-reduce:transition-none",
      )}
    >
      <StrategyGlyph
        slug={slug}
        strokeWidth={1.75}
        className="mt-0.5 h-10 w-10 text-foreground transition-colors duration-200 group-hover:text-primary group-focus-within:text-primary motion-reduce:transition-none"
      />

      <div className="min-w-0">
        {author ? (
          <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
            {author}
          </p>
        ) : null}
        <h2 className="mt-1 text-lg font-semibold leading-snug tracking-tight">
          <Link
            href={href}
            className="after:absolute after:inset-0 after:content-[''] hover:text-primary focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring"
          >
            {name}
          </Link>
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{tagline}</p>
        {/* Visual call to action only: the stretched title link already makes
            the whole row a target, and a second link to the same URL would be
            a redundant tab stop. */}
        <p aria-hidden="true" className="mt-3 text-sm font-medium text-primary">
          See the picks →
        </p>
      </div>

      {counts ? (
        <dl className="flex gap-2 md:justify-end">
          {(["triggered", "setup"] as const).map((status) => (
            <Readout key={status} status={status} count={counts[status]} />
          ))}
        </dl>
      ) : (
        <div aria-hidden="true" />
      )}

      {counts ? (
        leaders.length > 0 ? (
          <ul
            className="divide-y divide-border/40 border-y border-border/40"
            aria-label={`Top ${name} picks`}
          >
            {leaders.map((leader) => (
              <li key={leader.code} className="flex items-center gap-2.5 py-1.5 text-sm">
                <StockLogo
                  code={leader.code}
                  logoUrl={leader.logoUrl}
                  size="sm"
                  className="pointer-events-none"
                />
                <Link
                  href={`/shorts/${leader.code}`}
                  prefetch={false}
                  className="hit-target relative z-10 font-semibold text-primary hover:underline"
                >
                  {leader.code}
                </Link>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {leader.name}
                </span>
                <StatusPill status={leader.status} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground md:pt-2">
            No stock is triggered or set up today.
          </p>
        )
      ) : null}
    </article>
  );
}
