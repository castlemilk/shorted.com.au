import Link from "next/link";

import { cn } from "~/@/lib/utils";
import { StockLogo } from "~/@/components/reports/stock-logo";
import {
  STATUS_LABELS,
  formatStatusCount,
  type StatusCount,
} from "~/@/lib/strategies/shortlist";
import { PICK_STATUSES, type PickStatus } from "~/@/lib/strategies/types";
import { StatusPill } from "./picks-table";
import { StrategyArtPlate, hasStrategyArt } from "./strategy-art";
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
  counts: Record<PickStatus, StatusCount> | null;
  /** Ranked rows the counts were taken over (the API's page, at most 100). */
  ranked?: number;
  leaders: StrategyCardLeader[];
}

/**
 * The tape: one hairline band under the readouts, divided in proportion to
 * the ranked list's statuses (lit for triggered, hollow amber for setup,
 * muted for watch), so a row shows the shape of its list before a reader
 * counts. Decorative: the readouts above it carry the numbers. Nothing is
 * drawn for an empty list.
 */
export function StatusTape({
  counts,
  ranked,
}: {
  counts: Record<PickStatus, StatusCount>;
  ranked: number;
}) {
  const parts = PICK_STATUSES.map((status) => ({
    status,
    count: Math.max(0, Math.min(ranked, counts[status].count)),
  }));
  const total = parts.reduce((sum, part) => sum + part.count, 0);
  if (total <= 0) return null;
  return (
    <div
      aria-hidden="true"
      data-status-tape=""
      className="mt-2 flex h-1.5 w-full gap-px overflow-hidden rounded-[1px]"
    >
      {parts
        .filter((part) => part.count > 0)
        .map((part) => (
          <span
            key={part.status}
            data-tape-segment={part.status}
            style={{ flexGrow: part.count, flexBasis: 0 }}
            className={cn(
              "block min-w-[2px]",
              part.status === "triggered" && "bg-primary",
              part.status === "setup" && "border border-primary/70",
              part.status === "watch" && "bg-muted-foreground/30",
            )}
          />
        ))}
    </div>
  );
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
  ranked = 0,
  leaders,
}: StrategyCardProps) {
  const href = `/picks/${slug}`;
  // With art (the strategy's scene, or baked brandbrain art) the row gains
  // a plate column on md+ beside the glyph; without any, the grid is what
  // it was.
  const art = hasStrategyArt(slug);
  return (
    <article
      data-strategy-art-row={art ? "" : undefined}
      // The whole row is the scene's stage: moving across it plays the plate.
      data-scene-stage={art ? "" : undefined}
      className={cn(
        "group relative grid gap-4 p-4 sm:p-5",
        art
          ? "md:grid-cols-[7.5rem_2.5rem_minmax(0,1.3fr)_auto_minmax(0,1fr)]"
          : "md:grid-cols-[2.5rem_minmax(0,1.3fr)_auto_minmax(0,1fr)]",
        "md:items-start md:gap-x-6",
        "transition-colors duration-200 hover:bg-muted/30 focus-within:bg-muted/30 motion-reduce:transition-none",
      )}
    >
      {art ? (
        <StrategyArtPlate
          slug={slug}
          className="hidden md:block md:mt-0.5"
        />
      ) : null}
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
        <div className="md:min-w-[11.5rem]">
          <dl className="flex gap-2 md:justify-end">
            {(["triggered", "setup"] as const).map((status) => (
              <Readout key={status} status={status} count={counts[status]} />
            ))}
          </dl>
          <StatusTape counts={counts} ranked={ranked} />
        </div>
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
