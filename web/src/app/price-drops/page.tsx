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
  listAgencyPriceStats,
  listSuburbPriceDrops,
} from "~/app/actions/getHousing";
import { slugToState } from "@/lib/housing/states";
import { pageTitle, sectionTitle, eyebrow, lede } from "@/lib/typography";
import { cn } from "@/lib/utils";

const URL = "https://shorted.com.au/price-drops";
const TITLE = "Australian House Price Drops — by State, Suburb & Agency";
const DESCRIPTION =
  "Where Australian asking prices are falling: price cuts ranked by state, suburb, individual address and real-estate agency, tracked daily from realestate.com.au and Domain listings.";

// Cheap MV-backed fetches — render dynamically (the /scans pattern) so the
// first post-deploy visitor never sees a stale build-shell empty state.
export const dynamic = "force-dynamic";

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

interface PageProps {
  searchParams: Promise<{ state?: string }>;
}

export default async function PriceDropsPage({ searchParams }: PageProps) {
  const { state } = await searchParams;
  const stateCode = state ? (slugToState(state) ?? "") : "";

  const [overview, suburbs, agencies] = await Promise.all([
    getPriceDropsOverview(),
    listSuburbPriceDrops("", "count", 15),
    listAgencyPriceStats("", "drops", 12),
  ]);

  const national = overview?.national;
  const states = overview?.states ?? [];
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
      {/* No LLMMeta here — it hardcodes ASIC/regulatory Dataset provenance,
          which would be false for portal-listing data. The Dataset JSON-LD
          below carries the correct provenance instead. */}
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
              <StateDropsBoard states={states} highlightState={stateCode} />
            </section>

            <section className="space-y-4">
              <SectionHeader
                icon="city"
                title="Suburbs cutting hardest"
                sub="Suburbs ranked by how many for-sale listings reduced their asking price in the last 30 days. A suburb needs at least three cut listings to appear."
              />
              <SuburbDropsLeaderboard suburbs={suburbs?.suburbs ?? []} />
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
              <AddressDropsBoard stateCode={stateCode} embedded />
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
