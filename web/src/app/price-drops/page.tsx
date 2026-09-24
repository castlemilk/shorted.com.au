import { Suspense } from "react";
import { preload } from "react-dom";
import type { Metadata } from "next";
import Link from "next/link";

import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { HousingIcon } from "@/components/housing/housing-icon";
import { AddressDropsBoard } from "@/components/housing/address-drops-board-loader";
import { NationalPulse } from "@/components/housing/price-drops/national-pulse";
import { DropIndexHero } from "@/components/housing/price-drops/drop-index-hero-loader";
import { CapitulationBoard } from "@/components/housing/price-drops/capitulation-board";
import { StateDropsMap } from "@/components/housing/price-drops/state-drops-map-loader";
import { StateDropsBoard } from "@/components/housing/price-drops/state-drops-board";
import { SuburbDropsLeaderboard } from "@/components/housing/price-drops/suburb-drops-leaderboard";
import { AgencyDropsBoard } from "@/components/housing/price-drops/agency-drops-board";
import { DropsStaleNotice } from "@/components/housing/price-drops/drops-stale-notice";
import {
  getDropIndexSeries,
  getPriceDropsOverview,
  listAddressPriceDrops,
  listAgencyPriceStats,
  listSuburbPriceDrops,
} from "~/app/actions/getHousing";
import { bailOnEmptyRender } from "~/app/actions/config";
import { LLMMeta } from "@/components/seo/llm-meta";
import { dropsFreshness, fmtDropsDate, timestampToDate } from "@/lib/housing/drops-freshness";
import { pageTitle, sectionTitle, eyebrow, lede } from "@/lib/typography";
import { cn } from "@/lib/utils";

const URL = "https://shorted.com.au/price-drops";
const TITLE = "Australian House Price Drops — by State, Suburb & Agency";
const DESCRIPTION =
  "Where Australian asking prices are falling: price cuts ranked by state, suburb, individual address and real-estate agency, tracked from realestate.com.au and Domain listings.";

// Static ISR — the price-drop corpus changes ~once/day after the crawl re-ingest,
// so anonymous aggregate fetches are KV-cached while flag-gated agency/address
// fetches consult the backend on each render; the route itself is prerendered.
// We deliberately do NOT read the request query in this server page
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
  const [overview, suburbs, agencies, addresses, dropIndex] = await Promise.all([
    getPriceDropsOverview(),
    // Fetch 25 (the /housing suburb panels' page size) and show the top 15 below,
    // so the backend MemoryCache serves ONE entry across both surfaces.
    listSuburbPriceDrops("", "count", 25),
    listAgencyPriceStats("", "drops", 12),
    // Seed the address board's default (all-states, biggest-%) view so the static
    // shell renders rows without a client round-trip.
    listAddressPriceDrops(),
    getDropIndexSeries(),
  ]);

  const national = overview?.national;
  const states = overview?.states ?? [];
  const suburbRows = (suburbs?.suburbs ?? []).slice(0, 15);
  const hasData = Boolean(national && national.totalActiveListings > 0);
  // The kill switch (a takedown) empties every crawl-derived read on purpose.
  // That is neither "loading" nor a cold fetch worth retrying per request.
  const withheld = overview?.withheld === true;
  // Every figure below is a rolling window anchored at the last view refresh,
  // so the page says what date it runs to, and warns once that date is old.
  // Computed at render: ISR regenerates at most hourly, and the crawl flush
  // busts it the moment new data lands.
  const freshness = dropsFreshness(overview);
  const stale = freshness.stale || dropsFreshness(suburbs).stale;
  const catalogSuburbs = national?.catalogSuburbs ?? 0;
  // The index's own data horizon: its snapshots are written daily even while
  // the crawl is down, so the reading must be dated against this, not the
  // snapshot date alone.
  const indexDataThroughIso = timestampToDate(dropIndex.dataThrough)?.toISOString();
  // What an empty page says. Only "loading" is a failed or cold fetch; the
  // other two are real, stable answers.
  //  - withheld: the kill switch (a takedown) empties every crawl-derived read
  //    on purpose; the takedown runbook revalidates the route when it flips.
  //  - dated: the views answered, with a data date, and counted no listing
  //    seen in the last 14 days — a crawl outage longer than that. It stays
  //    true until the crawl lands, and the crawl flush revalidates the route.
  const emptyState: "withheld" | "dated" | "loading" | null = hasData
    ? null
    : withheld
      ? "withheld"
      : national && freshness.dataToLabel
        ? "dated"
        : "loading";
  // A failed/cold fetch must not bake the "data is loading" shell into the
  // route cache for the whole revalidate window. The two stable answers cache
  // like any other render.
  if (emptyState === "loading") await bailOnEmptyRender();

  // Start the 493KB CF-edge-cached boundary fetch while the client-only map
  // chunk hydrates. Matching crossOrigin is required for useTopojson's fetch()
  // to reuse this preload instead of downloading the asset twice.
  if (states.length > 0) {
    preload("/geo/states.topojson", { as: "fetch", crossOrigin: "anonymous" });
  }

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: "Australian House Price Drops",
    description: DESCRIPTION,
    creator: { "@type": "Organization", name: "Shorted", url: "https://shorted.com.au" },
    isAccessibleForFree: true,
    // Aggregates derived from portal listings we do not license openly, so no
    // open-data licence is claimed — the site terms govern reuse.
    license: "https://shorted.com.au/terms",
    spatialCoverage: "Australia",
    temporalCoverage: "2026/..",
    // The view refresh, not the render time: an ISR regeneration over frozen
    // data must not tell a crawler the dataset changed.
    ...(freshness.asOfIso ? { dateModified: freshness.asOfIso } : {}),
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
            We track for-sale listings across{" "}
            {catalogSuburbs > 0 ? `a ${catalogSuburbs.toLocaleString("en-AU")}-suburb catalog` : "a catalog of suburbs"}{" "}
            in NSW, Victoria, Queensland, South Australia and Western Australia and
            record each asking-price cut — then roll them up by state, suburb, address
            and agency. Cuts beyond 40% are filtered as listing corrections; each
            address counts once even when it&apos;s listed on both portals.
          </p>
          {freshness.dataToLabel ? (
            <p className="mt-2 text-sm font-medium text-foreground" data-testid="price-drops-data-to">
              {freshness.dataToLabel}
              {freshness.asOfIso ? (
                <span className="font-normal text-muted-foreground">
                  {" "}· figures refreshed {fmtDropsDate(new Date(freshness.asOfIso))}
                </span>
              ) : null}
            </p>
          ) : null}
          <DropsStaleNotice
            freshness={{ ...freshness, stale }}
            scope="on this page"
            testId="price-drops-stale"
            className="mt-3"
          />
          <p className="mt-2 text-sm text-muted-foreground">
            Part of the{" "}
            <Link href="/housing" className="font-medium text-primary underline-offset-4 hover:underline">
              Australian house prices tracker →
            </Link>
          </p>
        </header>

        {emptyState ? (
          <p
            className="rounded-lg border border-border bg-muted/30 p-8 text-center text-sm text-muted-foreground"
            data-testid="price-drops-empty"
            data-empty-state={emptyState}
          >
            {/* A dated but empty rollup is not "loading": with every listing
                gated on a 14-day sighting, a crawl outage longer than that
                empties the views honestly. Say so instead of promising data. */}
            {emptyState === "withheld"
              ? "Price-drop figures are not available at the moment."
              : emptyState === "dated"
                ? `No listing has been seen since ${(freshness.dataToLabel ?? "").replace(/^Data to /, "")}. Every figure here counts only listings seen in the last 14 days, so there is nothing current to rank until the listing crawl resumes.`
                : "Price-drop data is loading — check back shortly."}
          </p>
        ) : (
          <>
            {dropIndex.points.length > 0 ? (
              <Suspense
                fallback={<div className="h-[160px] w-full animate-pulse rounded-xl bg-muted" />}
              >
                <DropIndexHero
                  points={dropIndex.points}
                  trackingSince={dropIndex.trackingSince}
                  dataThroughIso={indexDataThroughIso}
                />
              </Suspense>
            ) : null}

            {national ? <NationalPulse national={national} /> : null}

            <section className="space-y-4">
              <SectionHeader
                icon="location"
                title="Drops by state"
                sub="Share of tracked listings that cut their asking price in the last 30 days, counting only listings seen in the last 14 days. A state is ranked only when at least 60% of its tracked suburbs were swept in those 14 days — below that its share says more about crawl coverage than about discounting. Select a state on the map to filter the address board below; use the table for exact asking/sold aggregates and suburb explorers."
              />
              {/* useSearchParams stays inside this client-only island and under
                  Suspense so the server page remains static ISR. */}
              <Suspense
                fallback={<div className="h-[380px] w-full animate-pulse rounded-xl bg-muted" />}
              >
                <StateDropsMap states={states} />
              </Suspense>
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

            {dropIndex.points.length > 0 ? (
              <CapitulationBoard points={dropIndex.points} dataThroughIso={indexDataThroughIso} />
            ) : null}

            <section className="space-y-4">
              <SectionHeader
                icon="median-price"
                title="Biggest individual drops"
                sub="Physical addresses ranked by how far their asking price has fallen, from the earliest comparable ask of the same advert (a range guide is never compared with a fixed price, and the other portal's concurrent ask never counts as a cut) — deduped across portals and relists, with the marketing agency where captured. Each row opens the full per-address price history."
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
                  sub="Real-estate agencies ranked by asking-price cuts across their tracked listings in the last 30 days. Aggregates only — an agency needs at least three tracked active listings to appear. Agencies come from realestate.com.au listings only: Domain listings carry no agency, so their cuts are not attributed here."
                />
                <AgencyDropsBoard agencies={agencies?.agencies ?? []} />
              </section>
            ) : null}
          </>
        )}

        <div className="space-y-2 border-t border-border pt-4 text-xs text-muted-foreground">
          <p>
            <span className="font-medium text-foreground">Method &amp; caveats.</span>{" "}
            Derived from for-sale listings on realestate.com.au and Domain across
            {catalogSuburbs > 0 ? ` a ${catalogSuburbs.toLocaleString("en-AU")}-suburb` : " a"}{" "}
            catalog in NSW, VIC, QLD, SA and WA, centred on the capital cities and their
            fringes — state rollups reflect those suburbs, not whole-state markets. A
            listing counts as on the market only if the crawl saw it in the last 14
            days. &ldquo;Last 30 days&rdquo; windows run to the data date shown at the
            top of the page. Auction and
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
