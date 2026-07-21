import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";

import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { HousingIcon } from "@/components/housing/housing-icon";
import { AddressDropsBoard } from "@/components/housing/address-drops-board-loader";
import { NationalPulse } from "@/components/housing/price-drops/national-pulse";
import { StateDropsBoard } from "@/components/housing/price-drops/state-drops-board";
import { SuburbDropsLeaderboard } from "@/components/housing/price-drops/suburb-drops-leaderboard";
import { AgencyDropsBoard } from "@/components/housing/price-drops/agency-drops-board";
import {
  getPriceDropsOverview,
  listAddressPriceDrops,
  listAgencyPriceStats,
  listSuburbPriceDrops,
} from "~/app/actions/getHousing";
import { LLMMeta } from "@/components/seo/llm-meta";
import { pageTitle, sectionTitle, eyebrow, lede } from "@/lib/typography";
import { cn } from "@/lib/utils";

const URL = "https://shorted.com.au/price-drops";
const TITLE = "Australian House Price Drops — by State, Suburb & Agency";
const DESCRIPTION =
  "Where Australian asking prices are falling: price cuts ranked by state, suburb, individual address and real-estate agency, tracked daily from realestate.com.au and Domain listings.";

// Static ISR — the price-drop corpus changes ~once/day after the crawl re-ingest,
// so the three server fetches are KV-cached (getHousing.ts) and the route is
// prerendered. We deliberately do NOT read the request query in this server page
// (doing so forces dynamic rendering). The ?state= deep link is instead read
// client-side by AddressDropsBoard (under a Suspense boundary). Busted on the
// crawl event via /api/revalidate?path=/price-drops&flush=housing and warmed
// post-deploy by /api/static-pages/warm-cache.
export const revalidate = 3600;

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  keywords: [
    "house price drops Australia",
    "reduced asking price",
    "price cuts by suburb",
    "price drops by state",
    "real estate price reductions",
  ],
  alternates: { canonical: URL },
  openGraph: { type: "website", url: URL, title: TITLE, description: DESCRIPTION, siteName: "Shorted", locale: "en_AU" },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, creator: "@shorted___" },
};

function SectionHeader({
  icon,
  title,
  sub,
}: {
  icon: Parameters<typeof HousingIcon>[0]["name"];
  title: string;
  sub: string;
}) {
  return (
    <div>
      <h2 className={cn(sectionTitle, "flex items-center gap-2 text-foreground")}>
        <HousingIcon name={icon} size={22} /> {title}
      </h2>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{sub}</p>
    </div>
  );
}

export default async function PriceDropsPage() {
  const [overview, suburbs, agencies, addresses] = await Promise.all([
    getPriceDropsOverview(),
    // Fetch 25 (the /housing suburb panels' page size) and show the top 15 below,
    // so the backend MemoryCache serves ONE entry across both surfaces.
    listSuburbPriceDrops("", "count", 25),
    listAgencyPriceStats("", "drops", 12),
    // Seed the address board's default (all-states, biggest-%) view so the static
    // shell renders rows without a client round-trip.
    listAddressPriceDrops(),
  ]);

  const national = overview?.national;
  const states = overview?.states ?? [];
  const suburbRows = (suburbs?.suburbs ?? []).slice(0, 15);
  const hasData = Boolean(national && national.totalActiveListings > 0);

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: "Australian House Price Drops",
    description: DESCRIPTION,
    creator: { "@type": "Organization", name: "Shorted", url: "https://shorted.com.au" },
    isAccessibleForFree: true,
    spatialCoverage: "Australia",
    temporalCoverage: "2026/..",
  };

  return (
    <DashboardLayout>
      {/* LLMMeta now derives provenance from `dataSource` (realestate.com.au +
          Domain, not ASIC), so it's safe to emit here. The Dataset JSON-LD
          below complements it with the dataset-level provenance. */}
      <LLMMeta
        title={TITLE}
        description={DESCRIPTION}
        url={URL}
        dataSource="realestate.com.au, domain.com.au"
        dataFrequency="daily"
        keywords={[
          "house price drops Australia",
          "price cuts by suburb",
          "real estate price reductions",
        ]}
      />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />

      <div className="mx-auto max-w-6xl space-y-12 px-4 py-8">
        <header>
          <p className={eyebrow}>Housing intelligence</p>
          <h1 className={cn(pageTitle, "mt-2 text-foreground")}>
            Where asking prices are falling
          </h1>
          <p className={cn(lede, "max-w-3xl")}>
            Every day we track for-sale listings across Australia&apos;s five mainland
            capitals and record each asking-price cut — then roll them up by state,
            suburb, address and agency. Cuts beyond 40% are filtered as listing
            corrections; each address counts once even when it&apos;s listed on both
            portals.
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            Part of the{" "}
            <Link href="/housing" className="font-medium text-primary underline-offset-4 hover:underline">
              Australian house prices tracker →
            </Link>
          </p>
        </header>

        {!hasData ? (
          <p className="rounded-lg border border-border bg-muted/30 p-8 text-center text-sm text-muted-foreground">
            Price-drop data is loading — check back shortly.
          </p>
        ) : (
          <>
            {national ? <NationalPulse national={national} /> : null}

            <section className="space-y-4">
              <SectionHeader
                icon="location"
                title="Drops by state"
                sub="Share of tracked listings that cut their asking price in the last 30 days, with each state's median cut and asking/sold price aggregates across every tracked listing. Click a state for its suburb explorer."
              />
              <StateDropsBoard states={states} />
            </section>

            <section className="space-y-4">
              <SectionHeader
                icon="city"
                title="Suburbs cutting hardest"
                sub="Suburbs ranked by how many for-sale listings reduced their asking price in the last 30 days. A suburb needs at least three cut listings to appear."
              />
              <SuburbDropsLeaderboard suburbs={suburbRows} />
              <p className="text-sm text-muted-foreground">
                Browse every tracked suburb&apos;s asking and sold aggregates on the{" "}
                <Link href="/housing" className="font-medium text-primary underline-offset-4 hover:underline">
                  housing dashboard →
                </Link>
              </p>
            </section>

            <section className="space-y-4">
              <SectionHeader
                icon="median-price"
                title="Biggest individual drops"
                sub="Physical addresses ranked by how far their asking price has fallen — deduped across portals and relists, with the marketing agency where captured. Each row opens the full per-address price history."
              />
              {/* Suspense boundary required: AddressDropsBoard reads the ?state=
                  deep link via useSearchParams, which suspends on a static page
                  (the dynamic-import loading fallback does NOT satisfy it). */}
              <Suspense
                fallback={<div className="h-[480px] w-full animate-pulse rounded-xl bg-muted" />}
              >
                <AddressDropsBoard initialAddresses={addresses?.addresses ?? []} embedded />
              </Suspense>
            </section>

            {(agencies?.agencies?.length ?? 0) > 0 ? (
              <section className="space-y-4">
                <SectionHeader
                  icon="mortgage"
                  title="Agencies cutting hardest"
                  sub="Real-estate agencies ranked by asking-price cuts across their tracked listings in the last 30 days. Aggregates only — an agency needs at least three tracked active listings to appear, and the same agency may appear once per portal."
                />
                <AgencyDropsBoard agencies={agencies?.agencies ?? []} />
              </section>
            ) : null}
          </>
        )}

        <div className="space-y-2 border-t border-border pt-4 text-xs text-muted-foreground">
          <p>
            <span className="font-medium text-foreground">Method &amp; caveats.</span>{" "}
            Derived from for-sale listings on realestate.com.au and Domain across ~115
            metro suburbs in NSW, VIC, QLD, SA and WA — metro coverage only, so state
            rollups reflect capital-city listings, not whole-state markets. Auction and
            price-on-application listings carry no numeric ask and are excluded from
            price aggregates. *Sold figures are incidental captures of sold-tagged cards
            (the last displayed price, not a verified settlement price) — treat them as
            indicative. Individual listings are not republished; address rows link to
            our per-address history, which deep-links to the live portal page. Not
            financial advice.
          </p>
        </div>
      </div>
    </DashboardLayout>
  );
}
