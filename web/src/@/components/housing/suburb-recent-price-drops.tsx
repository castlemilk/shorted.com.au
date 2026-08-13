"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";

import { listSuburbDropListingsClient } from "~/app/actions/client/getHousingClient";
import { fmtPriceShort } from "@/lib/housing/price-scale";
import { HousingIcon } from "./housing-icon";

/**
 * Recently price-reduced for-sale listings for this suburb, deep-linking OUT to
 * the live portal page. Data is flag-gated server-side (ListSuburbDropListings
 * returns [] unless HOUSING_DROP_LISTINGS_ENABLED) — so this renders nothing
 * until the portal-listing tier is live and enabled.
 *
 * Kept as a client island rather than folded into the server-rendered profile:
 * these rows are crawl-derived and kill-switchable, so they must re-read at
 * request time rather than be baked into a 24h ISR page.
 */
export function RecentPriceDrops({
  salCode,
  regionCode,
}: {
  salCode: string;
  regionCode?: string;
}) {
  const { data } = useQuery({
    queryKey: ["suburb-drop-listings", salCode, regionCode ?? ""],
    queryFn: () => listSuburbDropListingsClient(salCode, regionCode ?? ""),
    staleTime: 30 * 60 * 1000,
  });
  const listings = data?.listings ?? [];
  if (listings.length === 0) return null;
  const portalName = (src: string) => (src === "domain" ? "Domain" : "realestate.com.au");
  const bedBath = (l: (typeof listings)[number]) =>
    [l.bedrooms ? `${l.bedrooms} bd` : "", l.bathrooms ? `${l.bathrooms} ba` : "", l.carSpaces ? `${l.carSpaces} car` : ""]
      .filter(Boolean).join(" · ");
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <h2 className="mb-1 flex items-center gap-2 font-serif text-lg text-foreground">
        <HousingIcon name="median-price" size={24} /> Recent price drops
      </h2>
      <p className="mb-3 text-xs text-muted-foreground">
        For-sale listings that recently cut their asking price. Links open the live portal listing.
      </p>
      <ul className="divide-y divide-border">
        {listings.map((l, i) => (
          <li key={`${l.source}-${i}`} className="flex items-center justify-between gap-3 py-2.5">
            <div className="min-w-0">
              {l.addressKey ? (
                <Link
                  href={`/housing/property/${encodeURIComponent(l.addressKey)}`}
                  className="block truncate text-sm text-foreground underline-offset-2 hover:underline"
                >
                  {l.displayAddress || "View listing"}
                </Link>
              ) : (
                <a
                  href={l.listingUrl}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="block truncate text-sm text-foreground underline-offset-2 hover:underline"
                >
                  {l.displayAddress || "View listing"}
                </a>
              )}
              <div className="mt-0.5 truncate text-xs text-muted-foreground">
                {[l.propertyType, bedBath(l)].filter(Boolean).join(" · ")}
                {l.propertyType || bedBath(l) ? " · " : ""}
                {portalName(l.source)}
              </div>
              {l.agencyName ? (
                <div className="mt-0.5 truncate text-xs text-muted-foreground/80">
                  Listed by {l.agencyName}
                  {l.agentNames.length > 0 ? ` — ${l.agentNames.slice(0, 2).join(", ")}` : ""}
                </div>
              ) : null}
            </div>
            <div className="shrink-0 text-right">
              <div className="font-mono text-sm font-semibold tabular-nums text-[color:var(--semantic-red)]">
                −{Math.round(l.dropPct * 100)}%
              </div>
              <div className="text-xs text-muted-foreground">
                <span className="line-through">{fmtPriceShort(l.prevPrice)}</span> → {fmtPriceShort(l.price)}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
