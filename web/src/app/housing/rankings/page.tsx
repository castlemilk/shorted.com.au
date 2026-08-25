import type { Metadata } from "next";
import Link from "next/link";

import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import {
  BreadcrumbListSchema,
  ItemListStructuredData,
} from "~/@/components/seo/enhanced-structured-data";
import { siteConfig } from "~/@/config/site";
import { HOUSING_RANKINGS } from "~/@/lib/housing-rankings/registry";
import { ALL_STATES, STATE_NAMES, stateSlug } from "~/@/lib/housing/states";
import { eyebrow, pageTitle } from "~/@/lib/typography";
import { cn } from "~/@/lib/utils";

export const metadata: Metadata = {
  title: "Australian Suburb House Price Rankings",
  description:
    "Compare Australia's cheapest, most expensive, fastest-growing, fastest-falling and most affordable suburbs by state using official price and ABS data.",
  keywords: [
    "Australian suburb rankings",
    "cheapest suburbs Australia",
    "fastest growing suburbs",
    "suburb house price rankings",
    "affordable suburbs Australia",
  ],
  openGraph: {
    title: "Australian Suburb House Price Rankings | Shorted",
    description:
      "Forty live state rankings for suburb prices, annual change and price-to-income affordability.",
    url: `${siteConfig.url}/housing/rankings`,
    siteName: siteConfig.name,
    type: "website",
    locale: "en_AU",
  },
  twitter: {
    site: "@shorted___",
    creator: "@shorted___",
    card: "summary_large_image",
    title: "Australian Suburb House Price Rankings",
    description:
      "Cheapest, most expensive, fastest-changing and most affordable suburbs in every state and territory.",
  },
  alternates: {
    canonical: `${siteConfig.url}/housing/rankings`,
    languages: {
      "en-AU": `${siteConfig.url}/housing/rankings`,
      "x-default": `${siteConfig.url}/housing/rankings`,
    },
  },
};

export const revalidate = 3600;

const breadcrumbSchema = [
  { name: "Home", url: siteConfig.url },
  { name: "Housing", url: `${siteConfig.url}/housing` },
  { name: "Rankings", url: `${siteConfig.url}/housing/rankings` },
];

export default function HousingRankingsIndexPage() {
  const rankings = Object.values(HOUSING_RANKINGS);

  return (
    <DashboardLayout>
      <BreadcrumbListSchema items={breadcrumbSchema} />
      <ItemListStructuredData
        name="Australian Suburb House Price Rankings"
        description="State-by-state suburb rankings from Valuer-General-derived prices and ABS Census demographics."
        itemType="WebPage"
        items={rankings.map((ranking) => ({
          name: ranking.h1,
          url: `${siteConfig.url}/housing/rankings/${ranking.slug}`,
          description: ranking.dek,
        }))}
      />

      <div className="space-y-10">
        <div className="mb-4">
          <Breadcrumbs
            items={[
              { label: "Housing", href: "/housing" },
              { label: "Rankings", href: "/housing/rankings" },
            ]}
          />
        </div>

        <section className="border-b border-border/40 pb-6">
          <p className={cn(eyebrow, "mb-2 font-medium")}>Housing rankings</p>
          <h1 className={cn(pageTitle, "max-w-4xl leading-[1.1]")}>
            Australian Suburb House Price Rankings
          </h1>
          <p className="mt-3 max-w-3xl text-muted-foreground">
            Forty fixed, live rankings over Australian suburbs: price extremes,
            year-on-year median movement and a simple price-to-household-income
            comparison. Choose a state or territory below, or explore the{" "}
            <Link href="/housing" className="text-primary hover:underline">
              national housing dashboard
            </Link>
            .
          </p>
        </section>

        {/* Driven by the registry, not ALL_STATES: only states with a priced
            suburb feed have rankings, and an empty state section would be a
            dead heading with nothing under it. */}
        {ALL_STATES.filter((stateCode) =>
          rankings.some((ranking) => ranking.stateCode === stateCode),
        ).map((stateCode) => {
          const stateName = STATE_NAMES[stateCode]!;
          const stateRankings = rankings.filter(
            (ranking) => ranking.stateCode === stateCode,
          );
          return (
            <section key={stateCode} aria-label={`${stateName} rankings`}>
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
                <h2 className="text-xl font-semibold tracking-tight">
                  <Link
                    href={`/housing/${stateSlug(stateCode)}`}
                    className="hover:text-primary"
                  >
                    {stateName}
                  </Link>
                </h2>
                <span className="text-xs text-muted-foreground">
                  {stateRankings.length} rankings
                </span>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
                {stateRankings.map((ranking) => (
                  <Link
                    key={ranking.slug}
                    href={`/housing/rankings/${ranking.slug}`}
                    aria-label={ranking.h1}
                    prefetch={false}
                    className="group block"
                  >
                    <article className="flex h-full flex-col rounded-lg border border-border/60 bg-card/50 p-4 transition-colors hover:border-primary/40">
                      <h3 className="font-semibold leading-snug transition-colors group-hover:text-primary">
                        {ranking.h1}
                      </h3>
                      <p className="mt-2 flex-1 text-sm leading-relaxed text-muted-foreground">
                        {ranking.dek}
                      </p>
                    </article>
                  </Link>
                ))}
              </div>
            </section>
          );
        })}

        <section className="border-t border-border/40 pt-6 text-sm leading-relaxed text-muted-foreground">
          <p>
            Rankings use Valuer-General-derived median house prices delivered by
            ListStateSuburbs and ABS Census demographics. Zero-price records and
            suburbs below 200 residents are excluded; price-to-income pages also
            require positive household income. Medians describe the sales mix
            and are not valuations, forecasts or advice. See current asking
            price reductions on the{" "}
            <Link href="/price-drops" className="text-primary hover:underline">
              property price-drops board
            </Link>
            .
          </p>
        </section>
      </div>
    </DashboardLayout>
  );
}
