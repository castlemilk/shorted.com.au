import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import {
  formatHousingMoney,
  formatHousingPercent,
} from "~/@/components/housing/housing-ranking-table";
import { Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import { BreadcrumbListSchema } from "~/@/components/seo/enhanced-structured-data";
import { siteConfig } from "~/@/config/site";
import { CAPITALS, CAPITAL_SLUGS, getCapital } from "~/@/lib/housing/capitals";
import { STATE_NAMES, stateSlug } from "~/@/lib/housing/states";
import { HOUSING_RANKINGS } from "~/@/lib/housing-rankings/registry";
import { cn } from "~/@/lib/utils";
import { eyebrow, pageTitle } from "~/@/lib/typography";
import { bailOnEmptyRender } from "~/app/actions/config";
import {
  getCapitalPrices,
  type CapitalPricePointSnapshot,
  type CapitalPriceSeriesSnapshot,
} from "~/app/actions/getCapitalPrices";
import { CapitalPriceChart } from "../_components/capital-price-charts";

interface PageProps {
  params: Promise<{ slug: string }>;
}

export const revalidate = 3600;
export const maxDuration = 60;

export function generateStaticParams() {
  return CAPITAL_SLUGS.map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const capital = getCapital(slug);
  if (!capital) notFound();

  const url = `${siteConfig.url}/housing/capitals/${capital.slug}`;
  return {
    title: capital.title,
    description: capital.description,
    keywords: capital.keywords,
    alternates: {
      canonical: url,
      languages: { "en-AU": url, "x-default": url },
    },
    openGraph: {
      title: `${capital.title} | ${siteConfig.name}`,
      description: capital.description,
      url,
      siteName: siteConfig.name,
      type: "website",
      locale: "en_AU",
    },
    twitter: {
      card: "summary_large_image",
      title: capital.title,
      description: capital.description,
      site: "@shorted___",
      creator: "@shorted___",
    },
  };
}

function latestPoint(series: CapitalPriceSeriesSnapshot | null) {
  return series?.points.at(-1) ?? null;
}

function changePercent(
  current: CapitalPricePointSnapshot | null,
  previous: CapitalPricePointSnapshot | undefined,
): number | null {
  if (!current || !previous || previous.value === 0) return null;
  return ((current.value - previous.value) / previous.value) * 100;
}

function yearAgoPoint(
  points: readonly CapitalPricePointSnapshot[],
  latest: CapitalPricePointSnapshot | null,
) {
  if (!latest) return undefined;
  const latestDate = new Date(`${latest.period}T00:00:00.000Z`);
  if (Number.isNaN(latestDate.getTime())) return undefined;

  return [...points].reverse().find((point) => {
    const date = new Date(`${point.period}T00:00:00.000Z`);
    return (
      date.getUTCFullYear() === latestDate.getUTCFullYear() - 1 &&
      date.getUTCMonth() === latestDate.getUTCMonth()
    );
  });
}

function formatPeriod(period: string): string {
  const date = new Date(`${period}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return period;
  return date.toLocaleDateString("en-AU", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function Metric({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note: string;
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-card/60 p-4">
      <h2 className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </h2>
      <p className="mt-2 text-2xl font-semibold tabular-nums tracking-tight">
        {value}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{note}</p>
    </div>
  );
}

export default async function CapitalDetailPage({ params }: PageProps) {
  const { slug } = await params;
  const capital = getCapital(slug);
  if (!capital) notFound();

  const snapshot = await getCapitalPrices(
    capital.regionCode,
    capital.restOfStateCode,
  );
  // Each is a series object or null, so ?? and || coincide here; ?? is what the
  // lint rule mandates and is the safer default if these ever become numbers.
  const hasSeries = Boolean(
    snapshot?.house ?? snapshot?.unit ?? snapshot?.restOfState,
  );
  if (!hasSeries) bailOnEmptyRender();

  const house = snapshot?.house ?? null;
  const unit = snapshot?.unit ?? null;
  const restOfState = snapshot?.restOfState ?? null;
  const latest = latestPoint(house);
  const previous = house?.points.at(-2);
  const quarterChange = changePercent(latest, previous);
  const annualChange = changePercent(
    latest,
    yearAgoPoint(house?.points ?? [], latest),
  );
  const stateName = STATE_NAMES[capital.stateCode]!;
  const statePath = `/housing/${stateSlug(capital.stateCode)}`;
  const economyPath = `/economy/${stateSlug(capital.stateCode)}`;
  const pageUrl = `${siteConfig.url}/housing/capitals/${capital.slug}`;
  const rankingLinks = ["NSW", "VIC", "SA"].includes(capital.stateCode)
    ? Object.values(HOUSING_RANKINGS).filter(
        (ranking) => ranking.stateCode === capital.stateCode,
      )
    : [];

  const breadcrumbItems = [
    { label: "Housing", href: "/housing" },
    { label: "Capital cities", href: "/housing/capitals" },
    { label: capital.name, href: `/housing/capitals/${capital.slug}` },
  ];
  const breadcrumbSchema = [
    { name: "Home", url: siteConfig.url },
    { name: "Housing", url: `${siteConfig.url}/housing` },
    { name: "Capital cities", url: `${siteConfig.url}/housing/capitals` },
    { name: capital.name, url: pageUrl },
  ];
  const datasetSchema = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: `${capital.name} established-house transfer prices`,
    description: capital.description,
    url: pageUrl,
    dateModified: latest ? `${latest.period}T00:00:00.000Z` : undefined,
    temporalCoverage: house?.points[0]
      ? `${house.points[0].period.slice(0, 4)}/..`
      : "2002/..",
    spatialCoverage: {
      "@type": "Place",
      name: capital.name,
      addressCountry: "AU",
    },
    creator: {
      "@type": "Organization",
      name: "Australian Bureau of Statistics",
      url: "https://www.abs.gov.au/",
    },
    license: "https://creativecommons.org/licenses/by/4.0/",
    measurementTechnique:
      "Quarterly median of established-house transfers; recent observations may be preliminary and revised",
    variableMeasured: [
      "Established-house transfer median",
      "Attached-dwelling transfer median",
    ],
  };

  return (
    <DashboardLayout>
      <BreadcrumbListSchema items={breadcrumbSchema} />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(datasetSchema) }}
      />
      <div className="mx-auto max-w-6xl space-y-9 px-4 py-8 sm:py-10">
        <Breadcrumbs items={breadcrumbItems} />

        <header className="max-w-4xl border-b border-border/50 pb-7">
          <p className={cn(eyebrow, "mb-2 font-medium")}>
            <Link href="/housing/capitals" className="hover:text-foreground">
              Capital city prices
            </Link>
          </p>
          <h1 className={cn(pageTitle, "leading-[1.08]")}>{capital.h1}</h1>
          <p className="mt-4 max-w-3xl text-base leading-relaxed text-muted-foreground sm:text-lg">
            {capital.dek}
          </p>
        </header>

        {hasSeries ? (
          <>
            <section
              aria-label={`${capital.name} latest house price measures`}
              className="grid gap-3 sm:grid-cols-3"
            >
              <Metric
                label="Latest median"
                value={latest ? formatHousingMoney(latest.value) : "—"}
                note={latest ? formatPeriod(latest.period) : "No house series"}
              />
              <Metric
                label="Quarterly change"
                value={
                  quarterChange === null
                    ? "—"
                    : formatHousingPercent(quarterChange)
                }
                note="Versus previous quarter"
              />
              <Metric
                label="Annual change"
                value={
                  annualChange === null
                    ? "—"
                    : formatHousingPercent(annualChange)
                }
                note="Versus the same quarter a year earlier"
              />
            </section>

            {latest?.isPreliminary ? (
              <p className="rounded-lg border border-amber-500/25 bg-amber-500/8 px-4 py-3 text-sm text-muted-foreground">
                The latest ABS observation is preliminary and may be revised in
                a later quarterly release.
              </p>
            ) : null}

            {house ? (
              <section aria-labelledby="history-heading" className="space-y-3">
                <div className="max-w-3xl">
                  <h2 id="history-heading" className="text-xl font-semibold">
                    Established house price history
                  </h2>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                    Quarterly median transfer price across {capital.name}. The
                    collector requests the full ABS history from 2002-Q1.
                  </p>
                </div>
                <div className="rounded-xl border border-border/60 bg-card/40 p-3 sm:p-5">
                  <CapitalPriceChart
                    series={[
                      { label: "Established houses", points: house.points },
                    ]}
                    ariaLabel={`${capital.name} established house price history`}
                    format="aud"
                    height={360}
                  />
                </div>
              </section>
            ) : null}

            {house && unit ? (
              <section
                aria-labelledby="dwelling-comparison-heading"
                className="space-y-3"
              >
                <div className="max-w-3xl">
                  <h2
                    id="dwelling-comparison-heading"
                    className="text-xl font-semibold"
                  >
                    House versus unit prices
                  </h2>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                    Established houses and attached dwellings are separate ABS
                    transfer series; the gap is not a like-for-like valuation.
                  </p>
                </div>
                <div className="rounded-xl border border-border/60 bg-card/40 p-3 sm:p-5">
                  <CapitalPriceChart
                    series={[
                      { label: "Established houses", points: house.points },
                      { label: "Attached dwellings", points: unit.points },
                    ]}
                    ariaLabel={`${capital.name} house and unit price comparison`}
                    format="aud"
                    height={340}
                  />
                </div>
              </section>
            ) : null}

            {capital.restOfStateCode ? (
              house && restOfState ? (
                <section
                  aria-labelledby="regional-comparison-heading"
                  className="space-y-3"
                >
                  <div className="max-w-3xl">
                    <h2
                      id="regional-comparison-heading"
                      className="text-xl font-semibold"
                    >
                      {capital.name} versus Rest of {stateName}
                    </h2>
                    <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                      The same established-house transfer measure across the
                      capital region and the ABS rest-of-state region.
                    </p>
                  </div>
                  <div className="rounded-xl border border-border/60 bg-card/40 p-3 sm:p-5">
                    <CapitalPriceChart
                      series={[
                        { label: capital.name, points: house.points },
                        {
                          label: `Rest of ${stateName}`,
                          points: restOfState.points,
                        },
                      ]}
                      ariaLabel={`${capital.name} and Rest of ${stateName} house price comparison`}
                      format="aud"
                      height={340}
                    />
                  </div>
                </section>
              ) : (
                <p className="rounded-lg border border-border/60 bg-card/40 p-4 text-sm text-muted-foreground">
                  The rest-of-state comparison is temporarily unavailable; the
                  capital series remains available above.
                </p>
              )
            ) : (
              <p className="rounded-lg border border-border/60 bg-card/40 p-4 text-sm text-muted-foreground">
                The ACT is a territory-wide ABS region. There is no separate
                rest-of-territory series, so no regional counterpart is
                fabricated here.
              </p>
            )}
          </>
        ) : (
          <section className="rounded-xl border border-border/60 bg-card/50 p-6 text-sm text-muted-foreground">
            Capital price history is temporarily unavailable; this route will
            retry automatically rather than cache an empty snapshot.
          </section>
        )}

        <section
          id="about"
          aria-labelledby="about-heading"
          className="max-w-4xl"
        >
          <h2 id="about-heading" className="text-xl font-semibold">
            What this ABS median measures
          </h2>
          <p className="mt-3 text-sm leading-7 text-muted-foreground">
            {capital.blurb}
          </p>
          <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
            Source: Australian Bureau of Statistics (ABS). Licensed under{" "}
            <a
              href="https://creativecommons.org/licenses/by/4.0/"
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              CC BY 4.0
            </a>
            . Preliminary status is supplied with each observation and retained
            in this page’s cached snapshot.
          </p>
        </section>

        <section
          aria-labelledby="related-capitals-heading"
          className="border-t border-border/50 pt-6"
        >
          <h2 id="related-capitals-heading" className="text-lg font-semibold">
            More housing and economic context
          </h2>
          <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <li>
              <Link href={statePath} className="text-primary hover:underline">
                {stateName} housing
              </Link>
            </li>
            <li>
              <Link href={economyPath} className="text-primary hover:underline">
                {stateName} economy
              </Link>
            </li>
            <li>
              <Link
                href="/housing/capitals"
                className="text-primary hover:underline"
              >
                All capital city prices
              </Link>
            </li>
          </ul>

          {rankingLinks.length > 0 ? (
            <>
              <h3 className="mt-6 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {stateName} suburb rankings
              </h3>
              <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
                {rankingLinks.map((ranking) => (
                  <li key={ranking.slug}>
                    <Link
                      href={`/housing/rankings/${ranking.slug}`}
                      className="text-primary hover:underline"
                    >
                      {ranking.h1}
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          <h3 className="mt-6 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Other capitals
          </h3>
          <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
            {CAPITALS.filter(
              (candidate) => candidate.slug !== capital.slug,
            ).map((candidate) => (
              <li key={candidate.slug}>
                <Link
                  href={`/housing/capitals/${candidate.slug}`}
                  className="text-primary hover:underline"
                >
                  {candidate.name}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </DashboardLayout>
  );
}
