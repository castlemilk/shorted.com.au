import { type Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { cn } from "~/@/lib/utils";
import { eyebrow, pageTitle, sectionTitle } from "~/@/lib/typography";
import { siteConfig } from "~/@/config/site";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import {
  BreadcrumbListSchema,
  DatasetStructuredData,
  ItemListStructuredData,
} from "~/@/components/seo/enhanced-structured-data";
import { RegimeBanner } from "~/@/components/picks/regime-banner";
import { PicksProvenance } from "~/@/components/picks/picks-provenance";
import { PicksFilterView } from "~/@/components/picks/picks-filter-view";
import { RuleLegend, type RuleColumn } from "~/@/components/picks/picks-table";
import { StrategyPanel } from "~/@/components/picks/strategy-panel";
import { StrategySwitcher } from "~/@/components/picks/strategy-switcher";
import {
  STRATEGIES,
  STRATEGY_SLUGS,
  getStrategy,
} from "~/@/lib/strategies/registry";
import { STATUS_LABELS, shortlistRows } from "~/@/lib/strategies/shortlist";
import { firstNonEmpty, formatPrice } from "~/@/lib/strategies/format";
import { fundamentalsHeld } from "~/@/lib/strategies/coverage";
import { getStrategyPicks } from "~/app/actions/getStrategyPicks";
import { bailOnEmptyRender } from "~/app/actions/config";
import { PicksSortedView } from "./picks-sorted-view";

interface PageProps {
  params: Promise<{ strategy: string }>;
}

// Static ISR with prerendered params, the /themes/[slug] pattern: one cached
// API read per strategy per hour, shared with the /picks hub. The cold-build
// hazard (skipForBuild bakes an empty shell) is handled by bailOnEmptyRender()
// below, and the post-promote sweep (config/isr-pages.json) refills it.
//
// No searchParams are read here: reading them silently forces dynamic
// rendering and throws the ISR away. ?status= and ?sort= are read client-side
// by PicksSortedView under a real <Suspense> boundary.
//
// NOTE: no loading.tsx on this route, so notFound() yields a real HTTP 404.
export const revalidate = 3600;
// A cold Cloud Run start evaluates the whole universe before it answers; the
// default function budget must not 504 it.
export const maxDuration = 60;

export function generateStaticParams() {
  return STRATEGY_SLUGS.map((strategy) => ({ strategy }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { strategy: slug } = await params;
  const seo = getStrategy(slug);
  if (!seo) {
    notFound();
  }
  const url = `${siteConfig.url}/picks/${seo.slug}`;
  return {
    title: seo.title,
    description: seo.description,
    keywords: seo.keywords,
    openGraph: {
      title: `${seo.title} | ${siteConfig.name}`,
      description: seo.description,
      url,
      siteName: siteConfig.name,
      type: "website",
      locale: "en_AU",
      // No `images` key: this route ships its own opengraph-image.tsx and an
      // explicit `images` here would SHADOW the file convention.
    },
    twitter: {
      site: "@shorted___",
      creator: "@shorted___",
      card: "summary_large_image",
      title: seo.title,
      description: seo.description,
    },
    alternates: {
      canonical: url,
      languages: { "en-AU": url, "x-default": url },
    },
  };
}

/** How many ranked names go into the ItemList JSON-LD. */
const ITEM_LIST_LIMIT = 15;

export default async function StrategyPicksPage({ params }: PageProps) {
  const { strategy: slug } = await params;
  const seo = getStrategy(slug);
  if (!seo) {
    notFound();
  }

  const data = await getStrategyPicks(seo.slug);
  // A failed or cold read must not bake the copy-only shell into the route
  // cache for the whole revalidate window. An empty-but-valid universe (the
  // views have data, nothing qualifies) is a real answer and is cached.
  if (!data) await bailOnEmptyRender();

  const strategy = data?.strategy ?? null;
  const rows = data?.picks ?? [];
  const rules: RuleColumn[] = (strategy?.rules ?? []).map((rule) => ({
    id: rule.id,
    title: rule.title,
  }));
  const pageUrl = `${siteConfig.url}/picks/${seo.slug}`;
  const strategyName = firstNonEmpty(strategy?.name, seo.label);
  const listRows = shortlistRows(rows).slice(0, ITEM_LIST_LIMIT);

  const breadcrumbItems = [
    { label: "Stock picker", href: "/picks" },
    { label: seo.h1, href: `/picks/${seo.slug}` },
  ];
  const breadcrumbsSchema = [
    { name: "Home", url: siteConfig.url },
    { name: "Stock picker", url: `${siteConfig.url}/picks` },
    { name: seo.h1, url: pageUrl },
  ];
  const filterProps = {
    rows,
    totalCount: data?.totalCount ?? 0,
    rules,
    basePath: `/picks/${seo.slug}`,
    caption: `${seo.h1}: ranked ASX picks`,
    showFundamentals: data
      ? fundamentalsHeld(data.fundamentalsRowsCount, data.fundamentalsCoverageCount)
      : false,
  };

  return (
    <DashboardLayout>
      <BreadcrumbListSchema items={breadcrumbsSchema} />
      <DatasetStructuredData
        datasetInfo={{
          name: `${seo.h1}: ASX stock picks`,
          description: seo.description,
          url: pageUrl,
          dateModified: data && data.asOf.length > 0 ? data.asOf : undefined,
        }}
      />
      {listRows.length > 0 ? (
        <ItemListStructuredData
          name={`${seo.h1}: ASX stock picks`}
          description={seo.description}
          items={listRows.map((row) => ({
            name: `${row.code} - ${row.name || row.code}`,
            url: `${siteConfig.url}/shorts/${row.code}`,
            description: [
              `${STATUS_LABELS[row.status]} under ${strategyName}`,
              `score ${Math.round(row.score)} of 100`,
              row.close !== null ? `close ${formatPrice(row.close)}` : null,
            ]
              .filter(Boolean)
              .join(", "),
          }))}
        />
      ) : null}

      <div className="space-y-8">
        <div className="mb-4">
          <Breadcrumbs items={breadcrumbItems} />
        </div>

        <StrategySwitcher current={seo.slug} />

        <section className="border-b border-border/40 pb-6">
          <p className={cn(eyebrow, "mb-2 font-medium")}>
            <Link href="/picks" className="hover:text-foreground">
              Stock picker
            </Link>
            {strategy?.author ? <> · {strategy.author}</> : null}
          </p>
          <h1 className={cn(pageTitle, "leading-[1.1]")}>{seo.h1}</h1>
          <p className="mt-2 max-w-3xl text-muted-foreground">{seo.dek}</p>
          <div className="mt-3">
            <PicksProvenance
              asOf={data?.asOf ?? ""}
              coverage={data?.fundamentalsCoverageCount ?? 0}
              rowsCount={data?.fundamentalsRowsCount ?? 0}
              universe={data?.universeCount ?? 0}
            />
          </div>
        </section>

        {data ? (
          <>
            <RegimeBanner
              regime={data.regime}
              label={`Market regime for ${strategyName}`}
            />

            <section aria-labelledby="picks-heading" className="space-y-4">
              <div className="space-y-2">
                <h2 id="picks-heading" className={sectionTitle}>
                  Ranked picks
                </h2>
                <RuleLegend rules={rules} />
              </div>
              {/* The fallback IS the server-rendered shortlist: useSearchParams
                  suspends on a static page, so what crawlers and first paint
                  get is this boundary's fallback, not the island. */}
              <Suspense fallback={<PicksFilterView {...filterProps} status={null} />}>
                <PicksSortedView {...filterProps} strategyId={seo.slug} />
              </Suspense>
              <p className="text-xs text-muted-foreground">
                Pivot is the top of the base: the breakout level, and the exit
                if the price closes back below it. Growth compares the latest
                reported period with the same span a year earlier: TTM is the
                trailing 12 months, FY a full year, HY a half year, and F marks
                a figure computed from a company filing. &quot;n/a&quot; means
                we do not hold the figure, never that it is zero;
                &quot;n/m&quot; means it is not meaningful (growth beyond
                +500% or below −95%, or a ratio for a bank, insurer or other
                financial).
              </p>
            </section>

            {strategy ? <StrategyPanel strategy={strategy} /> : null}
          </>
        ) : (
          <section className="rounded-lg border border-border/60 bg-card p-6 text-sm text-muted-foreground">
            Picks for this strategy are temporarily unavailable; they refresh
            automatically. Not financial advice.
          </section>
        )}

        <section
          aria-labelledby="related-heading"
          className="border-t border-border/40 pt-6"
        >
          <h2
            id="related-heading"
            className="text-xs font-medium uppercase tracking-wider text-muted-foreground"
          >
            Other strategies
          </h2>
          <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
            {seo.related.map((relatedSlug) => {
              const related = STRATEGIES[relatedSlug];
              if (!related) return null;
              return (
                <li key={relatedSlug}>
                  <Link
                    href={`/picks/${related.slug}`}
                    className="text-primary hover:underline"
                  >
                    {related.h1}
                  </Link>
                </li>
              );
            })}
          </ul>
          <ul className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <li>
              <Link href="/picks" className="text-primary hover:underline">
                All strategies
              </Link>
            </li>
            <li>
              <Link href="/scans" className="text-primary hover:underline">
                Short interest scans
              </Link>
            </li>
            <li>
              <Link href="/screener" className="text-primary hover:underline">
                Stock screener
              </Link>
            </li>
            <li>
              <Link href="/battlegrounds" className="text-primary hover:underline">
                Short squeeze candidates
              </Link>
            </li>
          </ul>
        </section>
      </div>
    </DashboardLayout>
  );
}
