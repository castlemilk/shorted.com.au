"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { listSuburbPriceDropsClient } from "~/app/actions/client/getHousingClient";
import { suburbHref } from "@/lib/housing/states";
import { fmtPriceShort } from "@/lib/housing/price-scale";
import { HousingIcon } from "./housing-icon";

type SortKey = "count" | "asking" | "sold" | "max";

export interface SuburbPriceDropsPanelProps {
  /** State filter; '' shows a national ranking. */
  stateCode?: string;
  title?: string;
  limit?: number;
}

/**
 * Per-suburb listing board from crawled portal listings: average asking + sold
 * price, listing counts, and the recent price-cut ("movers") signal. Derived
 * aggregate only — no individual addresses are shown here (that's the per-suburb
 * drill-down). Renders nothing until the crawl has produced data.
 */
export function SuburbPriceDropsPanel({ stateCode = "", title = "Suburb prices & movers", limit = 25 }: SuburbPriceDropsPanelProps) {
  const [sort, setSort] = useState<SortKey>("count");
  const { data, isLoading } = useQuery({
    queryKey: ["suburb-price-drops", stateCode, sort, limit],
    queryFn: () => listSuburbPriceDropsClient(stateCode, sort, limit),
    staleTime: 30 * 60 * 1000,
  });
  const rows = data?.suburbs ?? [];
  if (!isLoading && rows.length === 0) return null;

  const SortBtn = ({ k, label }: { k: SortKey; label: string }) => (
    <button
      type="button"
      onClick={() => setSort(k)}
      className={`rounded-md px-2 py-1 text-xs transition-colors ${
        sort === k ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );

  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-serif text-lg text-foreground">
          <HousingIcon name="median-price" size={20} /> {title}
        </h2>
        <div className="flex items-center gap-1">
          <SortBtn k="count" label="Most cuts" />
          <SortBtn k="asking" label="Avg asking" />
          <SortBtn k="sold" label="Avg sold" />
          <SortBtn k="max" label="Biggest cut" />
        </div>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        Average asking &amp; recent sold prices per suburb, with the count of for-sale listings that reduced
        their asking price in the last 30 days. Derived from realestate.com.au &amp; domain.com.au listings.
      </p>
      {isLoading ? (
        <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">Suburb</th>
                <th className="px-3 py-2 text-right font-medium">For sale</th>
                <th className="px-3 py-2 text-right font-medium">Avg asking</th>
                <th className="px-3 py-2 text-right font-medium">Avg sold</th>
                <th className="px-3 py-2 text-right font-medium">Cuts (30d)</th>
                <th className="px-3 py-2 text-right font-medium">Biggest cut</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.regionCode} className="border-b border-border/60 last:border-0 hover:bg-muted/30">
                  <td className="px-3 py-2">
                    <Link
                      href={suburbHref(r.stateCode, { salName: cleanName(r.salName), postcode: r.postcode, salCode: r.salCode })}
                      className="capitalize text-foreground underline-offset-2 hover:underline"
                    >
                      {cleanName(r.salName)}
                    </Link>
                    <span className="ml-1 text-[10px] uppercase text-muted-foreground">{r.stateCode}</span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-foreground">{r.forSaleCount}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-foreground">
                    {r.avgAsking > 0 ? fmtPriceShort(r.avgAsking) : "—"}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-foreground">
                    {r.avgSold > 0 ? fmtPriceShort(r.avgSold) : "—"}
                    {r.soldCount > 0 ? <span className="text-muted-foreground"> ({r.soldCount})</span> : null}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-foreground">
                    {r.droppedListingCount > 0 ? r.droppedListingCount : "—"}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-[color:var(--semantic-red)]">
                    {r.maxDropPct > 0 ? `−${Math.round(r.maxDropPct * 100)}%` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** "Bondi, NSW 2026" -> "bondi"; a bare "Bondi" -> "bondi". */
function cleanName(salName: string): string {
  return salName.replace(/,.*$/, "").trim().toLowerCase();
}
