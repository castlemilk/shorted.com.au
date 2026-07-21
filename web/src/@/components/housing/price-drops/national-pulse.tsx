import type { StatePriceDropSummary } from "~/gen/shorts/v1alpha1/shorts_pb";
import { fmtPriceShort } from "@/lib/housing/price-scale";
import { HousingIcon, type HousingIconName } from "@/components/housing/housing-icon";

/**
 * The national headline strip for /price-drops: how many addresses cut their
 * ask in the last 30 days, how deep the median cut runs, and what that adds up
 * to in dollars. Server-rendered stat tiles (no chart — a headline number is
 * the right form here).
 */
export function NationalPulse({ national }: { national: StatePriceDropSummary }) {
  const tiles: { icon: HousingIconName; label: string; value: string; sub: string }[] = [
    {
      icon: "median-price",
      label: "Addresses cut (30d)",
      value: national.droppedCount.toLocaleString("en-AU"),
      sub: `of ${national.totalActiveListings.toLocaleString("en-AU")} tracked active listings`,
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
      value: national.droppedShare > 0 ? `${(national.droppedShare * 100).toFixed(1)}%` : "—",
      sub: `${national.suburbsTracked} tracked metro suburbs`,
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
