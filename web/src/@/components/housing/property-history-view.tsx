"use client";

import { useQuery } from "@tanstack/react-query";
import { getPropertyHistoryClient } from "~/app/actions/client/getHousingClient";
import type { PropertyPriceEvent } from "~/gen/shorts/v1alpha1/shorts_pb";
import { fmtPriceShort } from "@/lib/housing/price-scale";
import { HousingIcon } from "./housing-icon";

export interface PropertyHistoryViewProps {
  addressKey: string;
}

const PRICE_KIND_LABEL: Record<string, string> = {
  fixed: "",
  range_low: "from",
  range_high: "up to",
  offers_over: "offers over",
  auction: "auction",
  poa: "price on application",
  unknown: "",
};

const LISTING_STATUS_LABEL: Record<string, string> = {
  for_sale: "For sale",
  under_offer: "Under offer",
  sold: "Sold",
  withdrawn: "Withdrawn",
  unknown: "Unknown",
};

const EVENT_TYPE_META: Record<string, { label: string; tone: "green" | "red" | "muted" }> = {
  first_seen: { label: "First listed", tone: "muted" },
  price_drop: { label: "Price cut", tone: "red" },
  price_rise: { label: "Price raised", tone: "green" },
  relisted: { label: "Relisted", tone: "muted" },
  status_change: { label: "Status change", tone: "muted" },
  delisted: { label: "Delisted", tone: "muted" },
};

const SOURCE_LABEL: Record<string, string> = { rea: "realestate.com.au", domain: "Domain" };

function fmtDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}

function fmtPrice(price: number, priceDisplay: string, priceKind: string): string {
  if (priceDisplay) return priceDisplay;
  if (price <= 0) return "Price undisclosed";
  const prefix = PRICE_KIND_LABEL[priceKind];
  return prefix ? `${prefix} ${fmtPriceShort(price)}` : fmtPriceShort(price);
}

function toneClass(tone: "green" | "red" | "muted"): string {
  if (tone === "red") return "border-[color:var(--semantic-red)]/30 bg-[color:var(--semantic-red)]/10 text-[color:var(--semantic-red)]";
  if (tone === "green") return "border-[color:var(--semantic-green)]/30 bg-[color:var(--semantic-green)]/10 text-[color:var(--semantic-green)]";
  return "border-border bg-muted/50 text-muted-foreground";
}

/**
 * Per-address price timeline — surfaces GetPropertyHistory (flag-gated
 * server-side by HOUSING_DROP_LISTINGS_ENABLED, same as the suburb
 * drops drill-down). Deep-links OUT to the live portal listing rather than
 * reproducing it; only derived price/status facts are rendered here.
 */
export function PropertyHistoryView({ addressKey }: PropertyHistoryViewProps) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["property-history", addressKey],
    queryFn: () => getPropertyHistoryClient(addressKey),
    staleTime: 30 * 60 * 1000,
    enabled: Boolean(addressKey),
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="h-8 w-2/3 animate-pulse rounded-md bg-muted" />
        <div className="h-40 w-full animate-pulse rounded-xl bg-muted" />
        <div className="h-64 w-full animate-pulse rounded-xl bg-muted" />
      </div>
    );
  }

  const current = data?.current;
  if (isError || !data || !current) {
    return <EmptyState />;
  }

  const events = [...data.events].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  const totalChangePct = data.firstPrice > 0 && data.currentPrice > 0
    ? ((data.currentPrice - data.firstPrice) / data.firstPrice) * 100
    : 0;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="font-serif text-2xl text-foreground sm:text-3xl">
          {data.displayAddress || "Property history"}
        </h1>
        <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
          <HousingIcon name="location" size={15} />
          {[data.suburb, data.stateCode, data.postcode].filter(Boolean).join(" ")}
        </p>
      </header>

      {data.distinctDwellings > 1 ? (
        <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
          <HousingIcon name="dwellings" size={16} className="mt-0.5" />
          <p>
            This address shows {data.distinctDwellings} different bedroom counts — the portal may have
            listed multiple units of one building without a unit number, so the timeline below can blend
            more than one dwelling.
          </p>
        </div>
      ) : null}

      <CurrentListingCard listing={current} />

      <SummaryStrip
        numListings={data.numListings}
        firstPrice={data.firstPrice}
        currentPrice={data.currentPrice}
        totalChangePct={totalChangePct}
      />

      <PriceTimeline events={events} />
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-dashed border-border bg-card p-8 text-center">
      <HousingIcon name="median-price" size={28} className="mx-auto mb-3 opacity-60" />
      <h1 className="font-serif text-lg text-foreground">Per-address history isn&apos;t available yet</h1>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
        We couldn&apos;t find a tracked price history for this address. It may not have been crawled yet, or
        per-address history may not be enabled for your account.
      </p>
    </div>
  );
}

type PropertyListingSnapshotLike = NonNullable<
  Awaited<ReturnType<typeof getPropertyHistoryClient>>
>["current"];

function CurrentListingCard({ listing }: { listing: PropertyListingSnapshotLike }) {
  if (!listing) return null;
  const bedBath = [
    listing.bedrooms ? `${listing.bedrooms} bd` : "",
    listing.bathrooms ? `${listing.bathrooms} ba` : "",
    listing.carSpaces ? `${listing.carSpaces} car` : "",
    listing.landSizeSqm > 0 ? `${Math.round(listing.landSizeSqm)}m²` : "",
  ].filter(Boolean).join(" · ");
  const statusLabel = LISTING_STATUS_LABEL[listing.listingStatus] ?? listing.listingStatus;

  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${
                listing.isActive
                  ? "border-[color:var(--semantic-green)]/30 bg-[color:var(--semantic-green)]/10 text-[color:var(--semantic-green)]"
                  : "border-border bg-muted/50 text-muted-foreground"
              }`}
            >
              {statusLabel}
            </span>
            {listing.propertyType ? (
              <span className="inline-flex items-center rounded-full border border-border bg-muted/50 px-2.5 py-0.5 text-xs text-muted-foreground">
                {listing.propertyType}
              </span>
            ) : null}
          </div>
          <div className="font-mono text-2xl font-semibold tabular-nums text-foreground">
            {fmtPrice(listing.price, listing.priceDisplay, listing.priceKind)}
          </div>
          {bedBath ? <p className="mt-1 text-sm text-muted-foreground">{bedBath}</p> : null}
          <p className="mt-2 text-xs text-muted-foreground">
            Listed {fmtDate(listing.firstSeenAt)} · last seen {fmtDate(listing.lastSeenAt)} ·{" "}
            {SOURCE_LABEL[listing.source] ?? listing.source}
          </p>
        </div>
        {listing.listingUrl ? (
          <a
            href={listing.listingUrl}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
          >
            View live listing ↗
          </a>
        ) : null}
      </div>
    </section>
  );
}

function SummaryStrip({
  numListings, firstPrice, currentPrice, totalChangePct,
}: {
  numListings: number;
  firstPrice: number;
  currentPrice: number;
  totalChangePct: number;
}) {
  return (
    <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <StatTile label="Listings tracked" value={String(numListings)} />
      <StatTile label="First price" value={firstPrice > 0 ? fmtPriceShort(firstPrice) : "—"} />
      <StatTile label="Current price" value={currentPrice > 0 ? fmtPriceShort(currentPrice) : "—"} />
      <StatTile
        label="Total change"
        value={firstPrice > 0 && currentPrice > 0 ? `${totalChangePct >= 0 ? "+" : ""}${totalChangePct.toFixed(1)}%` : "—"}
        tone={totalChangePct > 0 ? "green" : totalChangePct < 0 ? "red" : "muted"}
      />
    </section>
  );
}

function StatTile({ label, value, tone = "muted" }: { label: string; value: string; tone?: "green" | "red" | "muted" }) {
  const toneText = tone === "green"
    ? "text-[color:var(--semantic-green)]"
    : tone === "red"
      ? "text-[color:var(--semantic-red)]"
      : "text-foreground";
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`mt-1 font-mono text-lg font-semibold tabular-nums ${toneText}`}>{value}</div>
    </div>
  );
}

function PriceTimeline({ events }: { events: PropertyPriceEvent[] }) {
  if (events.length === 0) return null;
  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <h2 className="mb-1 flex items-center gap-2 font-serif text-lg text-foreground">
        <HousingIcon name="price-index" size={20} /> Price timeline
      </h2>
      <p className="mb-3 text-xs text-muted-foreground">
        Every price and status change tracked at this address, across all its listings and relists.
      </p>
      <ol className="relative space-y-0 border-l border-border pl-5">
        {events.map((e, i) => {
          const meta = EVENT_TYPE_META[e.eventType] ?? { label: e.eventType, tone: "muted" as const };
          const isDrop = e.eventType === "price_drop" && e.dropPct > 0;
          const isRise = e.eventType === "price_rise" && e.dropPct < 0;
          return (
            <li key={`${e.observedAt}-${i}`} className="relative py-2.5">
              <span
                aria-hidden
                className={`absolute -left-[26px] top-3.5 h-2.5 w-2.5 rounded-full border-2 border-card ${
                  meta.tone === "red" ? "bg-[color:var(--semantic-red)]" : meta.tone === "green" ? "bg-[color:var(--semantic-green)]" : "bg-muted-foreground"
                }`}
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${toneClass(meta.tone)}`}>
                    {meta.label}
                  </span>
                  <span className="text-xs text-muted-foreground">{fmtDate(e.observedAt)}</span>
                  <span className="text-[10px] uppercase text-muted-foreground/70">{SOURCE_LABEL[e.source] ?? e.source}</span>
                </div>
                <div className="text-right font-mono text-sm tabular-nums text-foreground">
                  {(isDrop || isRise) && e.prevPrice > 0 ? (
                    <>
                      <span className="text-muted-foreground line-through">{fmtPriceShort(e.prevPrice)}</span>
                      {" → "}
                      <span className={isDrop ? "text-[color:var(--semantic-red)]" : "text-[color:var(--semantic-green)]"}>
                        {fmtPriceShort(e.price)}
                      </span>
                      <span className={`ml-1.5 text-xs ${isDrop ? "text-[color:var(--semantic-red)]" : "text-[color:var(--semantic-green)]"}`}>
                        ({isDrop ? "−" : "+"}{Math.abs(Math.round(e.dropPct * 100))}%)
                      </span>
                    </>
                  ) : e.price > 0 ? (
                    fmtPriceShort(e.price)
                  ) : null}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
