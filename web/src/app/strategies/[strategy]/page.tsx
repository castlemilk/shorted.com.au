import { type Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { sectionTitle } from "~/@/lib/typography";
import { siteConfig } from "~/@/config/site";
import {
  BreadcrumbListSchema,
  DatasetStructuredData,
  ItemListStructuredData,
} from "~/@/components/seo/enhanced-structured-data";
import { RegimeBanner } from "~/@/components/picks/regime-banner";
import { PicksProvenance } from "~/@/components/picks/picks-provenance";
import { VersionChip } from "~/@/components/strategies/version-chip";
import { RuleLegend, type RuleColumn } from "~/@/components/picks/picks-table";
import { StrategyPanel } from "~/@/components/picks/strategy-panel";
import { StrategySwitcher } from "~/@/components/picks/strategy-switcher";
import { STRATEGIES, getStrategy } from "~/@/lib/strategies/registry";
import { strategyTabHref } from "~/@/lib/strategies/strategy-tabs";
import {
  STATUS_LABELS,
  statusCountsOf,
  shortlistRows,
} from "~/@/lib/strategies/shortlist";
import { firstNonEmpty, formatPrice } from "~/@/lib/strategies/format";
import { fundamentalsHeld } from "~/@/lib/strategies/coverage";
import { EvidenceCard } from "~/@/components/strategies/evidence-card";
import { getStrategyPicks } from "~/app/actions/getStrategyPicks";
import { getStrategyEvidence } from "~/app/actions/strategies/getStrategyEvidence";
import { getBacktestRun } from "~/app/actions/strategies/getBacktestRun";
import { bailOnEmptyRender } from "~/app/actions/config";
import { PicksSortedView } from "./picks-sorted-view";

interface PageProps {
  params: Promise<{ strategy: string }>;
}

// Static ISR (the params are prerendered by the layout), the /themes/[slug] pattern: one cached
// API read per strategy per hour, shared with the /strategies hub. The cold-build
// hazard (skipForBuild bakes an empty shell) is handled by bailOnEmptyRender()
// below, and the post-promote sweep (config/isr-pages.json) refills it.
//
// No searchParams are read here: reading them silently forces dynamic
// rendering and throws the ISR away. ?status= and ?sort= are read client-side
// by PicksSortedView, under the <Suspense> boundary it owns.
//
// The layout's generateStaticParams and dynamicParams = false answer an unknown
// slug with the routing 404 before this page runs; the notFound() below is the
// same answer for a slug the registry does not hold.
export const revalidate = 3600;
// A cold Cloud Run start evaluates the whole universe before it answers; the
// default function budget must not 504 it.
export const maxDuration = 60;

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { strategy: slug } = await params;
  const seo = getStrategy(slug);
  if (!seo) {
    notFound();
  }
  const url = `${siteConfig.url}/strategies/${seo.slug}`;
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

export default async function StrategyPicksPage({ params }: PageProps) {
  const { strategy: slug } = await params;
  const seo = getStrategy(slug);
  if (!seo) {
    notFound();
  }

  const [data, evidenceList, backtest] = await Promise.all([
    getStrategyPicks(seo.slug),
    getStrategyEvidence(),
    getBacktestRun(seo.slug),
  ]);
  // A failed or cold read must not bake the copy-only shell into the route
  // cache for the whole revalidate window. An empty-but-valid universe (the
  // views have data, nothing qualifies) is a real answer and is cached.
  if (!data) await bailOnEmptyRender();
  // The Evidence card is the Backtest tab's summary: a failed evidence read
  // shortens this route's revalidate like the picks read does, and the card is
  // left out rather than drawn from a guess.
  if (!evidenceList) await bailOnEmptyRender();
  const evidence =
    evidenceList?.strategies.find((s) => s.strategyId === seo.slug) ?? null;

  const strategy = data?.strategy ?? null;
  const rows = data?.picks ?? [];
  const rules: RuleColumn[] = (strategy?.rules ?? []).map((rule) => ({
    id: rule.id,
    title: rule.title,
    core: rule.core,
  }));
  const pageUrl = `${siteConfig.url}/strategies/${seo.slug}`;
  const strategyName = firstNonEmpty(strategy?.name, seo.label);
  // The shortlist is what the HTML and the island's props carry, so it is
  // bounded (SHORTLIST_MAX_ROWS) and the island gets the status counts over
  // every ranked row instead of the rows themselves. The ItemList names the
  // same rows, so it is the shortlist too.
  const shortlist = shortlistRows(rows);
  const counts = statusCountsOf({
    picks: rows,
    totalCount: data?.totalCount ?? 0,
    statusCounts: data?.statusCounts,
  });

  const breadcrumbsSchema = [
    { name: "Home", url: siteConfig.url },
    { name: "Strategies", url: `${siteConfig.url}/strategies` },
    { name: seo.h1, url: pageUrl },
  ];
  const filterProps = {
    rows: shortlist,
    counts,
    totalCount: data?.totalCount ?? 0,
    rules,
    basePath: `/strategies/${seo.slug}`,
    signalsHref: strategyTabHref(seo.slug, "signals"),
    caption: `${seo.h1}: ranked ASX picks`,
    showFundamentals: data
      ? fundamentalsHeld(data.fundamentalsRowsCount, data.fundamentalsCoverageCount)
      : false,
  };

  return (
    <>
      <BreadcrumbListSchema items={breadcrumbsSchema} />
      <DatasetStructuredData
        datasetInfo={{
          name: `${seo.h1}: ASX stock picks`,
          description: seo.description,
          url: pageUrl,
          dateModified: data && data.asOf.length > 0 ? data.asOf : undefined,
        }}
      />
      {shortlist.length > 0 ? (
        <ItemListStructuredData
          name={`${seo.h1}: ASX stock picks`}
          description={seo.description}
          items={shortlist.map((row) => ({
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
        <StrategySwitcher current={seo.slug} />

        <div className="space-y-2">
          {strategy?.author ? (
            <p className="text-sm text-muted-foreground">By {strategy.author}</p>
          ) : null}
          <VersionChip version={data?.version ?? strategy?.version ?? null} />
          <PicksProvenance
            asOf={data?.asOf ?? ""}
            coverage={data?.fundamentalsCoverageCount ?? 0}
            rowsCount={data?.fundamentalsRowsCount ?? 0}
            universe={data?.universeCount ?? 0}
            version={data?.version ?? strategy?.version ?? null}
          />
        </div>

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
              {/* What crawlers and first paint get is the island's Suspense
                  fallback, the shortlist drawn from these props:
                  useSearchParams suspends on a static page. No boundary here:
                  a server-side fallback is serialised into the RSC payload as
                  a second copy of every row. */}
              <PicksSortedView {...filterProps} strategyId={seo.slug} />
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
            {evidence ? (
              <EvidenceCard slug={seo.slug} evidence={evidence} run={backtest} />
            ) : null}
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
                    href={`/strategies/${related.slug}`}
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
              <Link href="/strategies" className="text-primary hover:underline">
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
    </>
  );
}
