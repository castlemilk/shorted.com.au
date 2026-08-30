import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import {
  HousingRankingTable,
  formatHousingMoney,
} from "~/@/components/housing/housing-ranking-table";
import { Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import {
  BreadcrumbListSchema,
  ItemListStructuredData,
} from "~/@/components/seo/enhanced-structured-data";
import { siteConfig } from "~/@/config/site";
import {
  HOUSING_RANKINGS,
  HOUSING_RANKING_SLUGS,
  getHousingRanking,
  type RankingDefinition,
} from "~/@/lib/housing-rankings/registry";
import { rankSuburbs, type RankedSuburb } from "~/@/lib/housing-rankings/rank";
import {
  STATE_NAMES,
  stateSlug,
  suburbHref,
  titleCaseName,
} from "~/@/lib/housing/states";
import { cn } from "~/@/lib/utils";
import { eyebrow, pageTitle } from "~/@/lib/typography";
import { bailOnEmptyRender } from "~/app/actions/config";
import { getHousingRankingData } from "~/app/actions/getHousingRankingData";

interface PageProps {
  params: Promise<{ slug: string }>;
}

// Static ISR over registry-owned params. No searchParams: reading them here
// would silently make the page dynamic and discard this hourly route cache.
export const revalidate = 3600;
export const maxDuration = 60;

export function generateStaticParams() {
  return HOUSING_RANKING_SLUGS.map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const ranking = getHousingRanking(slug);
  if (!ranking) notFound();

  const url = `${siteConfig.url}/housing/rankings/${ranking.slug}`;
  return {
    title: ranking.title,
    description: ranking.description,
    keywords: ranking.keywords,
    openGraph: {
      title: `${ranking.title} | ${siteConfig.name}`,
      description: ranking.description,
      url,
      siteName: siteConfig.name,
      type: "website",
      locale: "en_AU",
    },
    twitter: {
      site: "@shorted___",
      creator: "@shorted___",
      card: "summary_large_image",
      title: ranking.title,
      description: ranking.description,
    },
    alternates: {
      canonical: url,
      languages: { "en-AU": url, "x-default": url },
    },
  };
}

const MAX_RENDERED_ROWS = 100;

function formatAsOf(iso: string): string {
  if (!iso) return "";
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-AU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function leaderValue(row: RankedSuburb, ranking: RankingDefinition): string {
  if (ranking.metric === "growth-asc" || ranking.metric === "growth-desc") {
    return `${row.yoyPct > 0 ? "+" : ""}${row.yoyPct.toFixed(1)}%`;
  }
  if (ranking.metric === "affordability") {
    return `${row.affordabilityRatio!.toFixed(1)}× income`;
  }
  return formatHousingMoney(row.latestMedianPrice);
}

function LeaderTiles({
  rows,
  ranking,
}: {
  rows: RankedSuburb[];
  ranking: RankingDefinition;
}) {
  return (
    <section aria-label={`${ranking.h1} top three`}>
      <div className="grid gap-3 sm:grid-cols-3">
        {rows.slice(0, 3).map((row, index) => (
          <Link
            key={row.salCode}
            href={suburbHref(row.stateCode, row)}
            className="group rounded-lg border border-border/60 bg-card/50 p-4 transition-colors hover:border-primary/40"
          >
            <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {index + 1}
            </span>
            <h2 className="mt-1 font-semibold leading-snug group-hover:text-primary">
              {titleCaseName(row.salName)}
            </h2>
            <p className="mt-2 text-xl font-semibold tabular-nums">
              {leaderValue(row, ranking)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {ranking.metric === "affordability"
                ? `${formatHousingMoney(row.latestMedianPrice)} median · ${formatHousingMoney(row.medianWeeklyHhdIncome)}/wk income`
                : `${row.postcode} · ${row.population.toLocaleString("en-AU")} residents`}
            </p>
          </Link>
        ))}
      </div>
    </section>
  );
}

export default async function HousingRankingPage({ params }: PageProps) {
  const { slug } = await params;
  const ranking = getHousingRanking(slug);
  if (!ranking) notFound();

  const data = await getHousingRankingData(ranking.stateCode);
  const rankedRows = data ? rankSuburbs(data.suburbs, ranking.metric) : [];
  if (rankedRows.length === 0) bailOnEmptyRender();

  const visibleRows = rankedRows.slice(0, MAX_RENDERED_ROWS);
  const stateName = STATE_NAMES[ranking.stateCode]!;
  const statePath = `/housing/${stateSlug(ranking.stateCode)}`;
  const asOf = formatAsOf(data?.asOfDate ?? "");
  const sameMetricOtherStates = Object.values(HOUSING_RANKINGS).filter(
    (candidate) =>
      candidate.metric === ranking.metric &&
      candidate.stateCode !== ranking.stateCode,
  );

  const breadcrumbItems = [
    { label: "Housing", href: "/housing" },
    { label: "Rankings", href: "/housing/rankings" },
    { label: ranking.h1, href: `/housing/rankings/${ranking.slug}` },
  ];
  const breadcrumbSchema = [
    { name: "Home", url: siteConfig.url },
    { name: "Housing", url: `${siteConfig.url}/housing` },
    { name: "Rankings", url: `${siteConfig.url}/housing/rankings` },
    {
      name: ranking.h1,
      url: `${siteConfig.url}/housing/rankings/${ranking.slug}`,
    },
  ];

  return (
    <DashboardLayout>
      <BreadcrumbListSchema items={breadcrumbSchema} />
      {visibleRows.length > 0 ? (
        <ItemListStructuredData
          name={ranking.h1}
          description={ranking.description}
          itemType="Place"
          items={visibleRows.slice(0, 15).map((row) => ({
            name: titleCaseName(row.salName),
            url: `${siteConfig.url}${suburbHref(row.stateCode, row)}`,
            description: `${formatHousingMoney(row.latestMedianPrice)} median house price; ${row.yoyPct.toFixed(1)}% year-on-year change`,
          }))}
        />
      ) : null}

      <div className="space-y-8">
        <div className="mb-4">
          <Breadcrumbs items={breadcrumbItems} />
        </div>

        <section className="border-b border-border/40 pb-6">
          <p className={cn(eyebrow, "mb-2 font-medium")}>
            <Link href="/housing/rankings" className="hover:text-foreground">
              Housing rankings
            </Link>
          </p>
          <h1 className={cn(pageTitle, "leading-[1.1]")}>{ranking.h1}</h1>
          <p className="mt-2 max-w-3xl text-muted-foreground">{ranking.dek}</p>
          {asOf && rankedRows.length > 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">
              {rankedRows.length.toLocaleString("en-AU")} eligible suburbs ·
              latest price period{" "}
              <time
                dateTime={data!.asOfDate}
                className="font-medium text-foreground"
              >
                {asOf}
              </time>{" "}
              · Valuer-General and ABS data
            </p>
          ) : null}
        </section>

        {rankedRows.length > 0 ? (
          <>
            <LeaderTiles rows={rankedRows} ranking={ranking} />
            <section aria-labelledby="ranking-table-heading">
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                <h2
                  id="ranking-table-heading"
                  className="text-lg font-semibold tracking-tight"
                >
                  Ranked suburbs
                </h2>
                <span className="text-xs text-muted-foreground">
                  Population 200+ · positive price required
                </span>
              </div>
              <HousingRankingTable
                rows={visibleRows}
                caption={ranking.h1}
                metric={ranking.metric}
              />
              {rankedRows.length > visibleRows.length ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  Showing the top {visibleRows.length} of{" "}
                  {rankedRows.length.toLocaleString("en-AU")} eligible suburbs.
                </p>
              ) : null}
            </section>
          </>
        ) : (
          <section className="rounded-lg border border-border/60 bg-card/50 p-6 text-sm text-muted-foreground">
            Housing ranking data is temporarily unavailable; this page will
            retry automatically rather than cache an empty result.
          </section>
        )}

        <section
          id="about"
          aria-labelledby="about-heading"
          className="max-w-3xl space-y-3"
        >
          <h2 id="about-heading" className="text-lg font-semibold">
            About this ranking
          </h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {ranking.blurb}
          </p>
        </section>

        <section
          aria-labelledby="related-heading"
          className="border-t border-border/40 pt-6"
        >
          <h2
            id="related-heading"
            className="text-xs font-medium uppercase tracking-wider text-muted-foreground"
          >
            More {stateName} rankings
          </h2>
          <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
            {ranking.related.map((relatedSlug) => {
              const related = HOUSING_RANKINGS[relatedSlug];
              if (!related) return null;
              return (
                <li key={relatedSlug}>
                  <Link
                    href={`/housing/rankings/${relatedSlug}`}
                    className="text-primary hover:underline"
                  >
                    {related.h1}
                  </Link>
                </li>
              );
            })}
          </ul>

          <h2 className="mt-6 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Compare other states
          </h2>
          <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
            {sameMetricOtherStates.map((candidate) => (
              <li key={candidate.slug}>
                <Link
                  href={`/housing/rankings/${candidate.slug}`}
                  className="text-primary hover:underline"
                >
                  {STATE_NAMES[candidate.stateCode]}
                </Link>
              </li>
            ))}
          </ul>

          <ul className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <li>
              <Link href={statePath} className="text-primary hover:underline">
                All {stateName} suburbs
              </Link>
            </li>
            <li>
              <Link
                href="/housing/rankings"
                className="text-primary hover:underline"
              >
                All housing rankings
              </Link>
            </li>
            <li>
              <Link
                href="/price-drops"
                className="text-primary hover:underline"
              >
                Property price drops
              </Link>
            </li>
          </ul>
        </section>
      </div>
    </DashboardLayout>
  );
}
