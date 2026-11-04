import Link from "next/link";
import { NOT_AVAILABLE, formatPct } from "~/@/lib/fundamentals/format";
import { industryLabel } from "~/@/lib/industry-placeholder";
import { sectorOf } from "../desk/map-layout";
import { SectorIcon } from "../workspace/sector-icon";
import type { FundSectorWeight } from "./fund-model";

/** The sectors largest first; a sector with no stated weight goes last, by name. */
export function sortedSectors(sectors: readonly FundSectorWeight[]): FundSectorWeight[] {
  return [...sectors].sort((a, b) => {
    const wa = a.weightPct ?? -1;
    const wb = b.weightPct ?? -1;
    if (wa !== wb) return wb - wa;
    return a.industry < b.industry ? -1 : a.industry > b.industry ? 1 : 0;
  });
}

/**
 * The fund's sector concentration (spec 14.3): one bar per sector, its width the
 * share of the largest sector, its figure beside it. Read from the file's own sector
 * weights, so the bars sum to what the file states, not to a share of the company.
 * A sector's name opens the Portfolio tab zoomed to it (`?focus=`), the treemap's
 * own focus, so the two stay one control.
 */
export function SectorConcentration({ sectors }: { sectors: readonly FundSectorWeight[] }) {
  const rows = sortedSectors(sectors);
  const top = Math.max(0, ...rows.map((row) => row.weightPct ?? 0));
  return (
    <section aria-label="Sector concentration" className="space-y-3">
      <h2 className="font-mono text-sm font-semibold">Sector concentration</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No sector weights in this file.</p>
      ) : (
        <ul className="space-y-2.5">
          {rows.map((row) => {
            const share = row.weightPct !== null && top > 0 ? row.weightPct / top : 0;
            return (
              <li key={row.industry} className="space-y-1">
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <Link
                    href={`?tab=portfolio&focus=${encodeURIComponent(sectorOf(row.industry))}`}
                    scroll={false}
                    prefetch={false}
                    aria-label={`Focus ${industryLabel(row.industry) || NOT_AVAILABLE} in the portfolio map`}
                    className="flex min-w-0 items-center gap-1.5 rounded-sm underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <SectorIcon industry={row.industry} size={16} />
                    <span className="truncate">{industryLabel(row.industry) || NOT_AVAILABLE}</span>
                  </Link>
                  <span className="shrink-0 font-mono tabular-nums">{formatPct(row.weightPct, { digits: 1 })}</span>
                </div>
                <div aria-hidden="true" className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${Math.round(share * 1000) / 10}%` }} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
