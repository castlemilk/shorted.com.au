// Server component — the replacement for the old idle-deferred SuburbNearbyRail.
//
// The rail used to be a client island purely because picking neighbours needs the
// whole state's suburb list, and that list was only reachable from the browser.
// The page now fetches that list on the server (one shared, 24h-ISR-cached read
// per state, not one per visitor), so the neighbours can be chosen during render:
// no 5,000-row client fetch, no post-idle pop-in, and the links are in the HTML
// where crawlers can follow them.
import Link from "next/link";

import { suburbHref, titleCaseName } from "@/lib/housing/states";
import { fmtPriceShort } from "@/lib/housing/price-scale";
import type { SuburbContext, SuburbLike } from "@/lib/housing/suburb-stats";
import { HousingIcon } from "./housing-icon";

export function SuburbNearbyList({
  stateCode,
  nearby,
  basis,
}: {
  stateCode: string;
  nearby: readonly SuburbLike[];
  basis: SuburbContext["nearbyBasis"];
}) {
  if (!nearby.length) return null;
  // The heading has to follow the basis. Most states publish no postcode on the
  // suburb feed, so the list falls back to price similarity — and calling those
  // suburbs "nearby" would be false about half the time.
  const postcodeBasis = basis === "postcode";
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="flex items-center gap-1.5 font-serif text-base text-foreground">
        <HousingIcon name="nearby" size={22} />{" "}
        {postcodeBasis ? "Nearby suburbs" : "Comparable suburbs"}
      </h3>
      <p className="mb-2 mt-0.5 text-[11px] text-muted-foreground">
        {postcodeBasis
          ? "Same postcode."
          : `Closest by median house price across ${stateCode}.`}
      </p>
      <div className="flex flex-col">
        {nearby.map((n) => (
          <Link
            key={n.salCode}
            href={suburbHref(stateCode, n)}
            className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            <span className="truncate">{titleCaseName(n.salName)}</span>
            <span className="shrink-0 text-right">
              <span className="block font-mono text-[12px] font-semibold tabular-nums text-foreground">
                {n.latestMedianPrice > 0 ? fmtPriceShort(n.latestMedianPrice) : "—"}
              </span>
              {n.latestMedianPrice > 0 && n.yoyPct !== 0 ? (
                <span
                  className="block font-mono text-[10px] tabular-nums"
                  style={{
                    color: n.yoyPct >= 0 ? "var(--semantic-green-text)" : "var(--semantic-red-text)",
                  }}
                >
                  {n.yoyPct >= 0 ? "+" : ""}
                  {n.yoyPct.toFixed(1)}% yr
                </span>
              ) : null}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
