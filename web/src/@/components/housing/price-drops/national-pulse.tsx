import type { StatePriceDropSummary } from "~/gen/shorts/v1alpha1/housing_pb";
import { fmtPriceShort } from "@/lib/housing/price-scale";
import { HousingIcon, type HousingIconName } from "@/components/housing/housing-icon";
import { stateCoverage } from "@/lib/housing/drops-freshness";

/**
 * The national headline strip for /price-drops: how many addresses cut their
 * ask in the last 30 days, how deep the median cut runs, and what that adds up
 * to in dollars. Server-rendered stat tiles (no chart — a headline number is
 * the right form here).
 */
export function NationalPulse({ national }: { national: StatePriceDropSummary }) {
  // The share is held to the same coverage rule as the states on the board:
  // below it, the pooled share mostly measures which suburbs the crawl reached
  // (measured 2026-09-23: 184 of 500 swept, 65% of the active addresses in
  // VIC), and printing it beside the ranked states would read as a national
  // rate. The counts in the other tiles stay — they are true of what was seen.
  const shareRanked = stateCoverage(national).ranked;
  const tiles: { icon: HousingIconName; label: string; value: string; sub: string }[] = [
    {
      icon: "median-price",
      label: "Addresses cut (30d)",
      value: national.droppedCount.toLocaleString("en-AU"),
      sub: `of ${national.totalActiveListings.toLocaleString("en-AU")} listings seen in the last 14 days`,
    },
    {
      icon: "price-index",
      label: "Median cut",
      value: national.medianDropPct > 0 ? `−${(national.medianDropPct * 100).toFixed(1)}%` : "—",
      sub: `average −${(national.avgDropPct * 100).toFixed(1)}% · deepest −${Math.round(national.maxDropPct * 100)}%`,
    },
    {
      icon: "debt",
      label: "Value cut from asks",
      value: national.droppedValue > 0 ? fmtPriceShort(national.droppedValue) : "—",
      sub: "summed reductions across cut addresses",
    },
    {
      icon: "city",
      label: "Share of listings cut",
      value:
        shareRanked && national.droppedShare > 0
          ? `${(national.droppedShare * 100).toFixed(1)}%`
          : "—",
      sub: !shareRanked
        ? `Withheld — only ${national.suburbsSwept14d} of ${national.catalogSuburbs} tracked suburbs swept in 14 days`
        : national.catalogSuburbs > 0
          ? `${national.suburbsSwept14d} of ${national.catalogSuburbs} tracked suburbs swept in 14 days`
          : `${national.suburbsTracked} tracked suburbs`,
    },
  ];
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {tiles.map((t) => (
        <div key={t.label} className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <HousingIcon name={t.icon} size={15} /> {t.label}
          </div>
          <div className="mt-2 font-mono text-3xl font-semibold tabular-nums text-foreground">{t.value}</div>
          <div className="mt-1 text-xs text-muted-foreground">{t.sub}</div>
        </div>
      ))}
    </div>
  );
}
