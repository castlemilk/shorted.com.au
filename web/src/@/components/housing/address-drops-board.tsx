"use client";

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { listAddressPriceDropsClient } from "~/app/actions/client/getHousingClient";
import { fmtPriceShort } from "@/lib/housing/price-scale";
import { ALL_STATES, STATE_NAMES } from "@/lib/housing/states";
import { HousingIcon } from "./housing-icon";

export interface AddressDropsBoardProps {
  stateCode?: string;
  windowDays?: number;
  limit?: number;
}

const SOURCE_LABEL: Record<string, string> = { rea: "realestate.com.au", domain: "Domain" };

function bedBath(bedrooms: number, bathrooms: number): string {
  return [bedrooms ? `${bedrooms} bd` : "", bathrooms ? `${bathrooms} ba` : ""].filter(Boolean).join(" · ");
}

/**
 * Ranks individual physical addresses (deduped by stable address_key) by how far
 * their for-sale asking price has fallen over the window. Each row deep-links to
 * the per-address history page — the live-portal link is intentionally kept OFF
 * the board. Data is flag-gated server-side (ListAddressPriceDrops returns []
 * unless the portal-listing tier is enabled), so the board may be empty until the
 * crawl tier is live.
 */
const SORTS: { key: string; label: string }[] = [
  { key: "pct", label: "Biggest %" },
  { key: "abs", label: "Biggest $" },
  { key: "recent", label: "Most recent" },
];

export function AddressDropsBoard({ stateCode: initialState = "", windowDays = 90, limit = 50 }: AddressDropsBoardProps) {
  const [stateCode, setStateCode] = useState(initialState);
  const [sort, setSort] = useState("pct");

  const { data, isLoading } = useQuery({
    queryKey: ["address-price-drops", stateCode, windowDays, limit, sort],
    queryFn: () => listAddressPriceDropsClient(stateCode, windowDays, limit, sort),
    staleTime: 30 * 60 * 1000,
  });
  const rows = data?.addresses ?? [];

  return (
    <div className="space-y-4">
      <header className="space-y-3">
        <div>
          <h1 className="font-serif text-2xl text-foreground sm:text-3xl">Biggest price drops by address</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Individual properties ranked by how far their for-sale asking price has fallen, tracked from
            realestate.com.au and Domain listings.
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <StateChip active={stateCode === ""} label="All" onClick={() => setStateCode("")} />
          {ALL_STATES.map((code) => (
            <StateChip
              key={code}
              active={stateCode === code}
              label={code}
              title={STATE_NAMES[code]}
              onClick={() => setStateCode(code)}
            />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs text-muted-foreground">Sort by</span>
          {SORTS.map((s) => (
            <StateChip key={s.key} active={sort === s.key} label={s.label} onClick={() => setSort(s.key)} />
          ))}
        </div>
      </header>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-16 w-full animate-pulse rounded-lg bg-muted" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card p-8 text-center">
          <HousingIcon name="median-price" size={28} className="mx-auto mb-3 opacity-60" />
          <h2 className="font-serif text-lg text-foreground">No tracked price drops yet</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            This board is populated from live realestate.com.au and Domain listings. It may be empty until
            the per-address tracking feature is enabled and listings have been crawled for your selection.
          </p>
        </div>
      ) : (
        <ol className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {rows.map((r, i) => {
            const meta = [r.propertyType, bedBath(r.bedrooms, r.bathrooms), SOURCE_LABEL[r.latestSource] ?? r.latestSource]
              .filter(Boolean)
              .join(" · ");
            return (
              <li key={r.addressKey || `${r.displayAddress}-${i}`} className="flex items-center gap-3 px-4 py-3">
                <span className="w-6 shrink-0 text-right font-mono text-sm tabular-nums text-muted-foreground">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/housing/property/${encodeURIComponent(r.addressKey)}`}
                    className="block truncate text-sm font-medium text-foreground underline-offset-2 hover:underline"
                  >
                    {r.displayAddress || "View property"}
                  </Link>
                  <div className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground">
                    <HousingIcon name="location" size={12} />
                    {[r.suburb, r.stateCode, r.postcode].filter(Boolean).join(" ")}
                  </div>
                  {meta ? <div className="mt-0.5 truncate text-xs text-muted-foreground">{meta}</div> : null}
                </div>
                <div className="shrink-0 text-right">
                  <div className="font-mono text-sm font-semibold tabular-nums text-[color:var(--semantic-red)]">
                    −{Math.round(r.dropPct * 100)}%
                  </div>
                  <div className="text-xs tabular-nums text-muted-foreground">
                    <span className="line-through">{fmtPriceShort(r.firstPrice)}</span> → {fmtPriceShort(r.currentPrice)}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function StateChip({ active, label, title, onClick }: { active: boolean; label: string; title?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
        active
          ? "border-foreground bg-foreground text-background"
          : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );
}
