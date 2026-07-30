"use client";

/**
 * "Declared political interests" card for /shorts/[stockCode].
 *
 * Modelled on company-tax-card.tsx, the existing influence-layer precedent:
 * client-side fetch, and render NOTHING when there is no data.
 *
 * Rendering null on empty is an editorial decision, not just tidiness. "No
 * politicians hold this" is an unverifiable absence claim about named
 * individuals — a member may hold a stock through a vehicle the register does
 * not capture, or their declaration may not have resolved to a ticker. Silence
 * is honest; an explicit negative is not.
 */

import { useQuery } from "@tanstack/react-query";
import { toDate } from "@/lib/politics/timestamp";
import Link from "next/link";
import { Landmark } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { listStockPoliticiansClient } from "~/app/actions/client/getPoliticiansClient";
import {
  DeclaredPeriod,
  HolderBadge,
  PartyChip,
  SourceLine,
} from "@/components/politicians/compliance";
import { partyColorFromAb } from "@/lib/politics/party-palette";

export function PoliticianInterestsCard({ stockCode }: { stockCode: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["politician-interests", stockCode],
    queryFn: () => listStockPoliticiansClient(stockCode),
    staleTime: 60 * 60 * 1000,
    retry: false,
  });

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <Skeleton className="h-4 w-40" />
        </CardHeader>
        <CardContent className="space-y-2">
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-3/4" />
        </CardContent>
      </Card>
    );
  }

  if (!data || data.interests.length === 0) return null;

  const asAt = data.interests
    .map((i) => toDate(i.interest?.declaredFrom))
    .filter((d): d is Date => !!d)
    .sort((a, b) => b.getTime() - a.getTime())[0];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Landmark className="h-4 w-4 text-muted-foreground" aria-hidden />
          Declared political interests
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Federal parliamentarians who declare an interest in {stockCode}
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-2xl font-semibold tabular-nums">{data.politicianCount}</span>
          <span className="text-xs text-muted-foreground">
            {data.politicianCount === 1 ? "member" : "members"}
          </span>
        </div>

        {data.partyCounts.length > 0 && (
          <ul className="flex flex-wrap gap-1.5" aria-label="By party">
            {data.partyCounts.map((p) => (
              <li
                key={p.partyAb}
                className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground"
              >
                <span
                  aria-hidden
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ backgroundColor: partyColorFromAb(p.partyAb) }}
                />
                {p.party}
                <span className="tabular-nums font-medium text-foreground/80">
                  {p.politicianCount}
                </span>
              </li>
            ))}
          </ul>
        )}

        <ul className="divide-y">
          {data.interests.slice(0, 8).map((row, idx) => {
            const p = row.politician;
            const i = row.interest;
            if (!p || !i) return null;
            return (
              <li key={`${p.slug}-${i.holder}-${idx}`} className="flex flex-col gap-1 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/politicians/${p.slug}`} className="text-sm hover:underline">
                    {p.displayName}
                  </Link>
                  <HolderBadge holder={i.holder} />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <PartyChip partyAb={p.partyAb} />
                  <DeclaredPeriod
                    from={toDate(i.declaredFrom)}
                    fromKnown={i.declaredFromKnown}
                    to={toDate(i.declaredTo)}
                    currentlyDeclared={i.currentlyDeclared}
                  />
                </div>
              </li>
            );
          })}
        </ul>

        {data.interests.length > 8 && (
          <p className="text-xs text-muted-foreground">
            +{data.interests.length - 8} more declarations
          </p>
        )}

        <p className="text-[11px] leading-relaxed text-muted-foreground">
          The registers record <strong>what</strong> is held, never quantity or value.
        </p>
        <SourceLine asAt={asAt} surface={`stock ${stockCode}`} />
      </CardContent>
    </Card>
  );
}
