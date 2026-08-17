"use client";

import { cn } from "@/lib/utils";
import { sectionTitle, eyebrow } from "@/lib/typography";
import type { DropIndexPointView } from "./drop-index-hero";

/**
 * The index has ~two weeks of stable panel history; these two counters come
 * from `property_price_events`, which has five weeks. They are plain counts
 * of events on listings we actually observed, so they are far less sensitive
 * to the crawl catalog's growth than the equal-weighted index above — see
 * `drop_index.go`'s comment above the capitulation query for the full story.
 */
export function CapitulationBoard({ points }: { points: DropIndexPointView[] }) {
  const usable = points.filter((p) => !p.isGap);
  if (usable.length === 0) return null;
  const latest = usable[usable.length - 1]!;

  return (
    <section className="rounded-lg border bg-card p-6">
      <p className={cn(eyebrow)}>Capitulation</p>
      <h2 className={cn(sectionTitle, "mt-1")}>Vendors pulling and re-cutting</h2>
      <dl className="mt-4 grid grid-cols-2 gap-4">
        <div>
          <dt className="text-sm text-muted-foreground">Relisted lower (30d)</dt>
          <dd className="text-2xl font-semibold tabular-nums">{latest.relistedLower.toLocaleString()}</dd>
        </div>
        <div>
          <dt className="text-sm text-muted-foreground">Withdrawn (30d)</dt>
          <dd className="text-2xl font-semibold tabular-nums">{latest.delistedCount.toLocaleString()}</dd>
        </div>
      </dl>
      <p className="mt-4 text-xs text-muted-foreground">
        Counted from listings we observed, so these are far less sensitive to crawl coverage
        than the index above.
      </p>
    </section>
  );
}
