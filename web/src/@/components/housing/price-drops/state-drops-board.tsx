import Link from "next/link";
import type { StatePriceDropSummary } from "~/gen/shorts/v1alpha1/housing_pb";
import { fmtPriceShort } from "@/lib/housing/price-scale";
import { STATE_NAMES, stateSlug } from "@/lib/housing/states";
import { stateCoverage } from "@/lib/housing/drops-freshness";
import { cn } from "@/lib/utils";

/**
 * Per-state price-drop rollup: one row per state with a share-of-listings-cut
 * bar (single hue, magnitude job) plus the asking/sold aggregates rolled up
 * from every tracked listing. Server-rendered — plain HTML bars, no chart
 * runtime, fully indexable.
 *
 * Only states whose crawl coverage clears the rank threshold (stateCoverage)
 * get a bar and a place in the ranking. The rest follow them, with their
 * coverage in place of the bar: their share measures how much of the state
 * the crawl reached, not how hard it is discounting. Their other figures stay
 * — they are still true of the listings that were seen.
 */
export function StateDropsBoard({
  states,
  highlightState = "",
}: {
  states: StatePriceDropSummary[];
  highlightState?: string;
}) {
  if (states.length === 0) return null;
  // Stable partition: the API's own ordering within each group is preserved.
  const ranked = states.filter((s) => stateCoverage(s).ranked);
  const unranked = states.filter((s) => !stateCoverage(s).ranked);
  const rows = [...ranked, ...unranked];
  const maxShare = Math.max(...ranked.map((s) => s.droppedShare), 0.0001);

  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-card">
      <table className="w-full min-w-[760px] text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
            <th className="px-4 py-2.5 font-medium">State</th>
            <th className="px-3 py-2.5 font-medium">Share of listings cut (30d)</th>
            <th className="px-3 py-2.5 text-right font-medium">Cuts</th>
            <th className="px-3 py-2.5 text-right font-medium">Median cut</th>
            <th className="px-3 py-2.5 text-right font-medium">Value cut</th>
            <th className="px-3 py-2.5 text-right font-medium">Median asking</th>
            <th className="px-3 py-2.5 text-right font-medium">Median sold*</th>
            <th className="px-3 py-2.5 text-right font-medium">Tracked</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => {
            const coverage = stateCoverage(s);
            return (
            <tr
              key={s.stateCode}
              data-ranked={coverage.ranked ? "true" : "false"}
              className={cn(
                "border-b border-border/60 last:border-0 hover:bg-muted/30",
                highlightState === s.stateCode && "bg-primary/5",
                !coverage.ranked && "text-muted-foreground",
              )}
            >
              <td className="px-4 py-3">
                <Link
                  href={`/housing/${stateSlug(s.stateCode)}`}
                  className="font-medium text-foreground underline-offset-2 hover:underline"
                >
                  {STATE_NAMES[s.stateCode] ?? s.stateCode}
                </Link>
              </td>
              <td className="px-3 py-3">
                {coverage.ranked ? (
                  <div className="flex items-center gap-2">
                    <div className="h-2 w-full max-w-[180px] overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-[color:var(--semantic-red)]"
                        style={{ width: s.droppedShare > 0 ? `${Math.max((s.droppedShare / maxShare) * 100, 2)}%` : 0 }}
                      />
                    </div>
                    <span className="shrink-0 font-mono text-xs tabular-nums text-foreground">
                      {(s.droppedShare * 100).toFixed(1)}%
                    </span>
                  </div>
                ) : (
                  <span className="text-xs">
                    Not ranked — {s.suburbsSwept14d} of {s.catalogSuburbs} suburbs swept in 14 days
                  </span>
                )}
              </td>
              <td className="px-3 py-3 text-right font-mono tabular-nums text-foreground">{s.droppedCount}</td>
              <td className="px-3 py-3 text-right font-mono tabular-nums text-[color:var(--semantic-red)]">
                {s.medianDropPct > 0 ? `−${(s.medianDropPct * 100).toFixed(1)}%` : "—"}
              </td>
              <td className="px-3 py-3 text-right font-mono tabular-nums text-foreground">
                {s.droppedValue > 0 ? fmtPriceShort(s.droppedValue) : "—"}
              </td>
              <td className="px-3 py-3 text-right font-mono tabular-nums text-foreground">
                {s.medianAsking > 0 ? fmtPriceShort(s.medianAsking) : "—"}
              </td>
              <td className="px-3 py-3 text-right font-mono tabular-nums text-muted-foreground">
                {s.medianSold > 0 ? fmtPriceShort(s.medianSold) : "—"}
                {s.soldCount > 0 ? <span> ({s.soldCount})</span> : null}
              </td>
              <td className="px-3 py-3 text-right font-mono tabular-nums text-muted-foreground">
                {s.totalActiveListings.toLocaleString("en-AU")}
              </td>
            </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
