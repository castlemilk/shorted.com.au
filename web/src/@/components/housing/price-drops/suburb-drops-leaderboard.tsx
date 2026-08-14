import Link from "next/link";
import type { SuburbPriceDrop } from "~/gen/shorts/v1alpha1/housing_pb";
import { fmtPriceShort } from "@/lib/housing/price-scale";
import { suburbHref } from "@/lib/housing/states";

/** "Bondi, NSW 2026" -> "bondi"; a bare "Bondi" -> "bondi". */
function cleanName(salName: string): string {
  return salName.replace(/,.*$/, "").trim().toLowerCase();
}

/**
 * The suburbs where asking prices are falling hardest: cuts count, cut depth,
 * and the asking/sold aggregates for each. Server-rendered (SEO-visible) —
 * the interactive, sortable variant lives on /housing via
 * SuburbPriceDropsPanel; this board is the flagship ranked read.
 */
export function SuburbDropsLeaderboard({ suburbs }: { suburbs: SuburbPriceDrop[] }) {
  const rows = suburbs.filter((s) => s.droppedListingCount > 0);
  if (rows.length === 0) return null;
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-card">
      <table className="w-full min-w-[720px] text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
            <th className="w-10 px-3 py-2.5 text-right font-medium">#</th>
            <th className="px-3 py-2.5 font-medium">Suburb</th>
            <th className="px-3 py-2.5 text-right font-medium">Cuts (30d)</th>
            <th className="px-3 py-2.5 text-right font-medium">Share cut</th>
            <th className="px-3 py-2.5 text-right font-medium">Median cut</th>
            <th className="px-3 py-2.5 text-right font-medium">Biggest cut</th>
            <th className="px-3 py-2.5 text-right font-medium">Median asking</th>
            <th className="px-3 py-2.5 text-right font-medium">Median sold*</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.regionCode} className="border-b border-border/60 last:border-0 hover:bg-muted/30">
              <td className="px-3 py-2.5 text-right font-mono text-xs tabular-nums text-muted-foreground">{i + 1}</td>
              <td className="px-3 py-2.5">
                {r.salCode ? (
                  <Link
                    href={suburbHref(r.stateCode, { salName: cleanName(r.salName), postcode: r.postcode, salCode: r.salCode })}
                    className="capitalize text-foreground underline-offset-2 hover:underline"
                  >
                    {cleanName(r.salName)}
                  </Link>
                ) : (
                  <span className="capitalize text-foreground">{cleanName(r.salName)}</span>
                )}
                <span className="ml-1.5 text-[10px] uppercase text-muted-foreground">{r.stateCode}</span>
              </td>
              <td className="px-3 py-2.5 text-right font-mono tabular-nums text-foreground">{r.droppedListingCount}</td>
              <td className="px-3 py-2.5 text-right font-mono tabular-nums text-foreground">
                {r.droppedShare > 0 ? `${(r.droppedShare * 100).toFixed(1)}%` : "—"}
              </td>
              <td className="px-3 py-2.5 text-right font-mono tabular-nums text-[color:var(--semantic-red)]">
                {r.medianDropPct > 0 ? `−${(r.medianDropPct * 100).toFixed(1)}%` : "—"}
              </td>
              <td className="px-3 py-2.5 text-right font-mono tabular-nums text-[color:var(--semantic-red)]">
                {r.maxDropPct > 0 ? `−${Math.round(r.maxDropPct * 100)}%` : "—"}
              </td>
              <td className="px-3 py-2.5 text-right font-mono tabular-nums text-foreground">
                {r.medianAsking > 0 ? fmtPriceShort(r.medianAsking) : "—"}
              </td>
              <td className="px-3 py-2.5 text-right font-mono tabular-nums text-muted-foreground">
                {r.medianSold > 0 ? fmtPriceShort(r.medianSold) : "—"}
                {r.soldCount > 0 ? <span> ({r.soldCount})</span> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
