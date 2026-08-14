"use client";

/**
 * "Politician-declared property here" for /housing/[state]/[suburb].
 *
 * Mounted inside suburb-profile.tsx, which is already behind an ssr:false loader,
 * so the connect-web import is safe. Renders null when empty: an explicit
 * "no politician owns property here" is an absence claim we cannot verify.
 */

import { useQuery } from "@tanstack/react-query";
import { toDate } from "@/lib/politics/timestamp";
import Link from "next/link";
import { listSuburbPoliticiansClient } from "~/app/actions/client/getPoliticiansClient";
import {
  DeclaredPeriod,
  HolderBadge,
  PartyChip,
  SourceLine,
} from "@/components/politicians/compliance";

export function SuburbPoliticianPropertyCard({ salCode }: { salCode: string }) {
  const { data } = useQuery({
    queryKey: ["suburb-politicians", salCode],
    queryFn: () => listSuburbPoliticiansClient(salCode),
    staleTime: 60 * 60 * 1000,
    retry: false,
  });

  if (!data || data.properties.length === 0) return null;

  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium">Politician-declared property here</h3>
      <p className="text-[11px] text-muted-foreground">
        {data.declaringMemberCount}{" "}
        {data.declaringMemberCount === 1 ? "federal member declares" : "federal members declare"}{" "}
        real estate in {data.suburbName || "this suburb"}. The registers record location at suburb or
        area level only — they contain no street addresses.
      </p>
      <ul className="divide-y">
        {data.properties.map((row, idx) => {
          const p = row.politician;
          const i = row.interest;
          if (!p || !i) return null;
          return (
            <li key={`${p.slug}-${idx}`} className="flex flex-col gap-1 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <Link href={`/politicians/${p.slug}`} className="text-sm hover:underline">
                  {p.displayName}
                </Link>
                <HolderBadge holder={i.holder} />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <PartyChip partyAb={p.partyAb} />
                {i.secondaryText ? (
                  <span className="text-[11px] text-muted-foreground">{i.secondaryText}</span>
                ) : null}
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
      <SourceLine surface={`suburb ${data.suburbName || salCode}`} />
    </section>
  );
}
