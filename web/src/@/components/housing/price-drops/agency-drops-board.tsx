import type { AgencyPriceStats } from "~/gen/shorts/v1alpha1/housing_pb";
import { fmtPriceShort } from "@/lib/housing/price-scale";

const SOURCE_LABEL: Record<string, string> = { rea: "realestate.com.au", domain: "Domain" };

/**
 * Agencies ranked by recent asking-price cuts across their tracked for-sale
 * listings. Derived aggregates only (>=3 active listings floor); agency
 * identity is per-portal, so the portal is badged on each row. Server-rendered.
 */
export function AgencyDropsBoard({ agencies }: { agencies: AgencyPriceStats[] }) {
  const rows = agencies.filter((a) => a.agencyName);
  if (rows.length === 0) return null;
  return (
    <ol className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
      {rows.map((a, i) => (
        <li key={`${a.source}-${a.agencyId}-${a.stateCode}`} className="flex items-center gap-3 px-4 py-3">
          <span className="w-6 shrink-0 text-right font-mono text-sm tabular-nums text-muted-foreground">{i + 1}</span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="truncate text-sm font-medium text-foreground">{a.agencyName}</span>
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                {a.stateCode} · {SOURCE_LABEL[a.source] ?? a.source}
              </span>
            </div>
            <div className="mt-0.5 truncate text-xs text-muted-foreground">
              {a.activeListings} active listings
              {a.medianAsking > 0 ? ` · median ask ${fmtPriceShort(a.medianAsking)}` : ""}
              {a.suburbsCovered > 1 ? ` · ${a.suburbsCovered} suburbs` : ""}
            </div>
            {a.agentNames.length > 0 ? (
              <div className="mt-0.5 truncate text-xs text-muted-foreground/80">
                Agents: {a.agentNames.slice(0, 4).join(", ")}
                {a.agentNames.length > 4 ? "…" : ""}
              </div>
            ) : null}
          </div>
          <div className="shrink-0 text-right">
            <div className="font-mono text-sm font-semibold tabular-nums text-[color:var(--semantic-red)]">
              {a.droppedCount} cut{a.droppedCount === 1 ? "" : "s"}
            </div>
            <div className="text-xs tabular-nums text-muted-foreground">
              {a.avgDropPct > 0 ? `avg −${(a.avgDropPct * 100).toFixed(1)}%` : ""}
              {a.totalDropValue > 0 ? ` · ${fmtPriceShort(a.totalDropValue)}` : ""}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}
