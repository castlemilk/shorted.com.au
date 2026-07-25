"use client";

/**
 * "Declared by this state's members" for /economy/[state].
 *
 * A near-clone of state-companies.tsx, which is the established pattern for this
 * grid. Hosted inside state-charts.tsx, already behind an ssr:false loader.
 */

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { listStatePoliticianHoldingsClient } from "~/app/actions/client/getPoliticiansClient";
import { EconomyIcon } from "./economy-icon";
import type { StateSlug } from "@/lib/economy/map-metrics";
import { STATE_NAMES } from "@/lib/economy/map-metrics";

export function StatePoliticianHoldings({ state }: { state: StateSlug }) {
  const { data } = useQuery({
    queryKey: ["economy-state-politician-holdings", state],
    queryFn: () => listStatePoliticianHoldingsClient(state, 8),
    staleTime: 60 * 60 * 1000,
    retry: false,
  });

  if (!data || data.stocks.length === 0) return null;

  return (
    <section data-testid="state-politician-holdings" className="space-y-2">
      <h4 className="flex items-center gap-2 text-sm font-medium">
        <EconomyIcon name="company-footprint" className="h-4 w-4" />
        Declared by {STATE_NAMES[state] ?? state.toUpperCase()} members
      </h4>
      <p className="text-[11px] text-muted-foreground">
        ASX-listed companies declared in the registers of interests by the{" "}
        {data.politicianCount} federal parliamentarians representing this state or territory —
        senators for the state, and members for its divisions.
      </p>
      <ul className="divide-y">
        {data.stocks.map((s) => (
          <li key={s.stockCode} className="flex items-center justify-between gap-2 py-1.5">
            <Link href={`/shorts/${s.stockCode}`} className="text-sm hover:underline">
              <span className="font-medium">{s.stockCode}</span>
              {s.companyName ? (
                <span className="text-muted-foreground"> · {s.companyName}</span>
              ) : null}
            </Link>
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
              {s.politicianCount} {s.politicianCount === 1 ? "member" : "members"}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-muted-foreground">
        Counts are of members declaring an interest. The registers record what is held, never
        quantity or value.{" "}
        <Link href="/politicians" className="hover:text-foreground underline decoration-dotted">
          All declared interests →
        </Link>
      </p>
    </section>
  );
}
