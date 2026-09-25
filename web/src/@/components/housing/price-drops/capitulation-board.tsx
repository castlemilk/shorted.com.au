"use client";

import { cn } from "@/lib/utils";
import { sectionTitle, eyebrow } from "@/lib/typography";
import { describeReading, readingCaption, type DropIndexPointView } from "./drop-index-hero";

/**
 * The index has ~two weeks of stable panel history; these two counters come
 * from `property_price_events`, which has five weeks. They are plain counts
 * of events on listings we actually observed, so they are far less sensitive
 * to the crawl catalog's growth than the equal-weighted index above — see
 * `drop_index.go`'s comment above the capitulation query for the full story.
 */
export function CapitulationBoard({
  points,
  dataThroughIso,
}: {
  points: DropIndexPointView[];
  /** GetDropIndexSeries' data_through as an ISO string (see DropIndexHero). */
  dataThroughIso?: string;
}) {
  const reading = describeReading(points, dataThroughIso);
  if (!reading) return null;
  const { latest } = reading;

  return (
    <section className="rounded-lg border bg-card p-6">
      <p className={cn(eyebrow)}>Capitulation</p>
      <h2 className={cn(sectionTitle, "mt-1")}>Vendors pulling and re-cutting</h2>
      <p
        className={cn(
          "mt-1 text-sm",
          reading.gapsSince !== undefined || reading.dataTo !== undefined
            ? "text-amber-700 dark:text-amber-400"
            : "text-muted-foreground",
        )}
        data-testid="capitulation-reading-date"
      >
        {readingCaption(reading)}
      </p>
      <dl className="mt-4 grid grid-cols-2 gap-4">
        <div>
          <dt className="text-sm text-muted-foreground">Withdrawn then relisted (30d)</dt>
          <dd className="text-2xl font-semibold tabular-nums">
            {latest.withdrawnThenRelisted.toLocaleString()}
          </dd>
        </div>
        <div>
          <dt className="text-sm text-muted-foreground">Left the market (30d)</dt>
          <dd className="text-2xl font-semibold tabular-nums">{latest.delistedCount.toLocaleString()}</dd>
        </div>
      </dl>
      <p className="mt-4 text-xs text-muted-foreground">
        Counted from listings we observed, so these are far less sensitive to crawl coverage
        than the index above. &ldquo;Left the market&rdquo; counts listings that disappeared from
        the portals, whether sold or withdrawn — the portals rarely say which. &ldquo;Withdrawn then
        relisted&rdquo; requires more than a 7-day gap between the two events, to exclude same-week
        crawl re-sweep noise.
      </p>
    </section>
  );
}
