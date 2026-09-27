import Link from "next/link";

import { StockLogo } from "~/@/components/reports/stock-logo";
import {
  STATUS_LABELS,
  formatStatusCount,
  type StatusCount,
} from "~/@/lib/strategies/shortlist";
import type { PickStatus } from "~/@/lib/strategies/types";
import { StatusPill } from "./picks-table";

/**
 * One strategy on the /picks hub: who it comes from, what it looks for, how
 * many stocks meet it today, and the first names on its list. Flat card,
 * hairline border, 6px radius. The whole card is clickable through a
 * stretched title link (an overlay pseudo-element), with the stock-code links
 * raised above it: wrapping the card in one anchor would nest anchors.
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
    <article className="relative flex h-full flex-col rounded-lg border border-border/60 bg-card p-5 transition-colors focus-within:border-primary/40 hover:border-primary/40">
      {author ? (
        <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
          {author}
        </p>
      ) : null}
      <h2 className="mt-1 text-lg font-semibold leading-snug tracking-tight">
        <Link
          href={href}
          className="after:absolute after:inset-0 after:rounded-lg after:content-[''] hover:text-primary focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring"
        >
          {name}
        </Link>
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{tagline}</p>

      {counts ? (
        <dl className="mt-4 flex gap-6">
          {(["triggered", "setup"] as const).map((status) => (
            <div key={status}>
              <dt className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                {STATUS_LABELS[status]}
              </dt>
              <dd className="mt-1 text-2xl font-semibold leading-none tabular-nums">
                {formatStatusCount(counts[status])}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {counts ? (
        leaders.length > 0 ? (
          <ul className="mt-4 space-y-2" aria-label={`Top ${name} picks`}>
            {leaders.map((leader) => (
              <li key={leader.code} className="flex items-center gap-2.5 text-sm">
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
          <p className="mt-4 text-sm text-muted-foreground">
            No stock is triggered or set up today.
          </p>
        )
      ) : null}

      {/* Visual call to action only: the stretched title link already makes
          the whole card a target, and a second link to the same URL would be
          a redundant tab stop. */}
      <p aria-hidden="true" className="mt-auto pt-5 text-sm font-medium text-primary">
        See the picks →
      </p>
    </article>
  );
}
