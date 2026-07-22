"use client";

import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import type { AddressPriceDrop, ListAddressPriceDropsResponse } from "~/gen/shorts/v1alpha1/housing_pb";
import { listAddressPriceDropsClient } from "~/app/actions/client/getHousingClient";
import { fmtPriceShort } from "@/lib/housing/price-scale";
import { ALL_STATES, STATE_NAMES, slugToState } from "@/lib/housing/states";
import { HousingIcon } from "./housing-icon";

export interface AddressDropsBoardProps {
  stateCode?: string;
  windowDays?: number;
  limit?: number;
  /**
   * Server-fetched default (all-states, biggest-%) rows — seeds useQuery so the
   * static /price-drops shell paints rows without a first-load client round-trip.
   */
  initialAddresses?: AddressPriceDrop[];
  /** Embedded in a page that supplies its own section heading (e.g. /price-drops) — hides the board's own title block. */
  embedded?: boolean;
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

export function AddressDropsBoard({ stateCode: initialState = "", windowDays = 90, limit = 50, initialAddresses, embedded = false }: AddressDropsBoardProps) {
  // ?state= deep link (e.g. a shared /price-drops?state=vic URL) — read here on
  // the client so the page stays static ISR. slugToState maps "vic"→"VIC" and
  // drops anything invalid to "".
  const searchParams = useSearchParams();
  const stateFromUrl = slugToState(searchParams.get("state") ?? "") ?? "";
  const [stateCode, setStateCode] = useState(initialState || stateFromUrl);
  const [sort, setSort] = useState("pct");

  // The server-seeded rows are the all-states / biggest-% view; only reuse them
  // as initialData when the current selection still IS that view, otherwise a
  // filter/sort change must fetch live. An EMPTY seed is also rejected — with
  // initialData present, TanStack treats the data as fresh for the whole
  // staleTime and never fires the client fetch, so seeding [] (e.g. the server
  // fetch failed while the rest of the page succeeded) would pin the board to
  // its empty state instead of letting the client fetch recover.
  const isDefaultView = stateCode === "" && sort === "pct";

  const { data, isLoading } = useQuery({
    queryKey: ["address-price-drops", stateCode, windowDays, limit, sort],
    queryFn: () => listAddressPriceDropsClient(stateCode, windowDays, limit, sort),
    staleTime: 30 * 60 * 1000,
    initialData:
      isDefaultView && initialAddresses && initialAddresses.length > 0
        ? ({
            $typeName: "shorts.v1alpha1.ListAddressPriceDropsResponse",
            addresses: initialAddresses,
          } satisfies ListAddressPriceDropsResponse)
        : undefined,
  });
  const rows = data?.addresses ?? [];

  return (
    <div className="space-y-4">
      <header className="space-y-3">
        {!embedded ? (
          <div>
            <h1 className="font-serif text-2xl text-foreground sm:text-3xl">Biggest price drops by address</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Individual properties ranked by how far their for-sale asking price has fallen, tracked from
              realestate.com.au and Domain listings.
            </p>
          </div>
        ) : null}
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
        <>
        <CutSizeStrip drops={rows.map((r) => r.dropPct)} />
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
                  {r.agencyName ? (
                    <div className="mt-0.5 truncate text-xs text-muted-foreground/80">
                      Listed by {r.agencyName}
                      {r.agentNames.length > 0 ? ` — ${r.agentNames.slice(0, 2).join(", ")}` : ""}
                    </div>
                  ) : null}
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
        </>
      )}
    </div>
  );
}

const CUT_BUCKETS: { label: string; min: number; max: number }[] = [
  { label: "3–5%", min: 0.03, max: 0.05 },
  { label: "5–10%", min: 0.05, max: 0.1 },
  { label: "10–15%", min: 0.1, max: 0.15 },
  { label: "15–20%", min: 0.15, max: 0.2 },
  { label: "20%+", min: 0.2, max: Infinity },
];

/** Compact cut-size distribution for the drops currently in view (single-hue bars). */
function CutSizeStrip({ drops }: { drops: number[] }) {
  if (drops.length < 8) return null;
  const counts = CUT_BUCKETS.map((b) => drops.filter((d) => d >= b.min && d < b.max).length);
  const max = Math.max(...counts, 1);
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Cut-size distribution · {drops.length} drops in view
      </div>
      <div className="space-y-1.5">
        {CUT_BUCKETS.map((b, i) => (
          <div key={b.label} className="flex items-center gap-2">
            <span className="w-14 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">
              {b.label}
            </span>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-[color:var(--semantic-red)]"
                style={{ width: `${(counts[i]! / max) * 100}%` }}
              />
            </div>
            <span className="w-8 shrink-0 font-mono text-xs tabular-nums text-foreground">{counts[i]}</span>
          </div>
        ))}
      </div>
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
