import type { Metadata } from "next";
import Link from "next/link";

import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { formatHousingMoney } from "~/@/components/housing/housing-ranking-table";
import { Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import { siteConfig } from "~/@/config/site";
import { CAPITALS } from "~/@/lib/housing/capitals";
import { cn } from "~/@/lib/utils";
import { eyebrow, pageTitle } from "~/@/lib/typography";
import { bailOnEmptyRender } from "~/app/actions/config";
import {
  getCapitalPrices,
  type CapitalPriceSeriesSnapshot,
} from "~/app/actions/getCapitalPrices";

export const revalidate = 3600;

const canonical = `${siteConfig.url}/housing/capitals`;
const description =
  "Compare median house prices by Australian capital city, ranked from official quarterly ABS established-house transfers with house-versus-unit spreads.";

export const metadata: Metadata = {
  title: "Median House Price by Capital City Australia",
  description,
  keywords: [
    "median house price by capital city Australia",
    "Australian capital city house prices",
    "house versus unit prices Australia",
    "ABS house price data",
  ],
  alternates: {
    canonical,
    languages: { "en-AU": canonical, "x-default": canonical },
  },
  openGraph: {
    title: `Median House Price by Capital City Australia | ${siteConfig.name}`,
    description,
    url: canonical,
    siteName: siteConfig.name,
    type: "website",
    locale: "en_AU",
  },
  twitter: {
    card: "summary_large_image",
    title: "Median House Price by Capital City Australia",
    description,
    site: "@shorted___",
    creator: "@shorted___",
  },
};

function latestPoint(series: CapitalPriceSeriesSnapshot | null) {
  return series?.points.at(-1) ?? null;
}

export default async function CapitalCitiesPage() {
  const snapshots = await Promise.all(
    CAPITALS.map(async (capital) => ({
      capital,
      snapshot: await getCapitalPrices(
        capital.regionCode,
        capital.restOfStateCode,
      ),
    })),
  );

  const ranked = snapshots
    .map(({ capital, snapshot }) => ({
      capital,
      house: latestPoint(snapshot?.house ?? null),
      unit: latestPoint(snapshot?.unit ?? null),
    }))
    .sort((a, b) => (b.house?.value ?? -1) - (a.house?.value ?? -1));
  const hasHousePrices = ranked.some(({ house }) => house !== null);
  if (!hasHousePrices) bailOnEmptyRender();

  const itemListSchema = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "Australian capital city median house prices",
    description,
    numberOfItems: ranked.filter(({ house }) => house !== null).length,
    itemListElement: ranked.flatMap(({ capital, house }, index) =>
      house
        ? [
            {
              "@type": "ListItem",
              position: index + 1,
              name: capital.name,
              url: `${canonical}/${capital.slug}`,
            },
          ]
        : [],
    ),
  };

  return (
    <DashboardLayout>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(itemListSchema) }}
      />
      <div className="mx-auto max-w-6xl space-y-8 px-4 py-8 sm:py-10">
        <Breadcrumbs
          items={[
            { label: "Housing", href: "/housing" },
            { label: "Capital cities", href: "/housing/capitals" },
          ]}
        />

        <header className="max-w-4xl border-b border-border/50 pb-7">
          <p className={cn(eyebrow, "mb-2 font-medium")}>ABS housing data</p>
          <h1 className={cn(pageTitle, "leading-[1.08]")}>
            Median house price by capital city Australia
          </h1>
          <p className="mt-4 max-w-3xl text-base leading-relaxed text-muted-foreground sm:text-lg">
            Eight official capital-region medians, ranked by the latest
            quarterly price for established-house transfers. Each card also
            compares the corresponding attached-dwelling median.
          </p>
        </header>

        {hasHousePrices ? (
          <ol
            aria-label="Capital city house prices"
            className="grid gap-4 md:grid-cols-2"
          >
            {ranked.map(({ capital, house, unit }, index) => {
              const spread =
                house && unit ? house.value - unit.value : undefined;
              const spreadLabel =
                spread === undefined
                  ? "Unit comparison unavailable"
                  : spread >= 0
                    ? `House premium ${formatHousingMoney(spread)}`
                    : `Attached-dwelling premium ${formatHousingMoney(-spread)}`;

              return (
                <li key={capital.slug}>
                  <Link
                    href={`/housing/capitals/${capital.slug}`}
                    className="group flex h-full flex-col rounded-xl border border-border/60 bg-card/60 p-5 transition-colors hover:border-primary/45 hover:bg-card"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <span className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
                          {house ? `Rank ${index + 1}` : "Awaiting data"}
                        </span>
                        <h2 className="mt-1 font-serif text-2xl font-semibold tracking-tight group-hover:text-primary">
                          {capital.name}
                        </h2>
                      </div>
                      <span className="rounded-full border border-border/60 px-2.5 py-1 text-xs font-medium text-muted-foreground">
                        {capital.stateCode}
                      </span>
                    </div>
                    <p className="mt-6 text-3xl font-semibold tabular-nums tracking-tight">
                      {house ? formatHousingMoney(house.value) : "Unavailable"}
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Established-house median
                      {house?.isPreliminary ? " · Preliminary" : ""}
                    </p>
                    <div className="mt-5 border-t border-border/50 pt-4 text-sm">
                      <span className="font-medium text-foreground">
                        {spreadLabel}
                      </span>
                      {unit ? (
                        <span className="mt-1 block text-muted-foreground">
                          Attached dwellings {formatHousingMoney(unit.value)}
                        </span>
                      ) : null}
                    </div>
                  </Link>
                </li>
              );
            })}
          </ol>
        ) : (
          <section className="rounded-xl border border-border/60 bg-card/50 p-6 text-sm text-muted-foreground">
            Capital price data is temporarily unavailable; this page will retry
            automatically rather than cache an empty result.
          </section>
        )}

        <aside className="border-t border-border/50 pt-5 text-sm leading-relaxed text-muted-foreground">
          <p>
            Source: Australian Bureau of Statistics (ABS), quarterly medians of
            established-house and attached-dwelling transfers. Licensed under{" "}
            <a
              href="https://creativecommons.org/licenses/by/4.0/"
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              CC BY 4.0
            </a>
            . Recent observations can be preliminary and revised.
          </p>
        </aside>
      </div>
    </DashboardLayout>
  );
}
