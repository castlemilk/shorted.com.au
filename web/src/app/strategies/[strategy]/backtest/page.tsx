import { type Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { sectionTitle } from "~/@/lib/typography";
import { siteConfig } from "~/@/config/site";
import { BreadcrumbListSchema } from "~/@/components/seo/enhanced-structured-data";
import { getStrategy } from "~/@/lib/strategies/registry";
import { isIndexableBacktest } from "~/@/lib/strategies/backtest-windows";
import { strategyTabHref } from "~/@/lib/strategies/strategy-tabs";
import {
  NOT_COMPUTABLE_BODY,
  VARIANT_CALLOUT_COPY,
  notComputableHeadline,
  notComputableNoLabel,
  runRequiredCopy,
  runningCopy,
} from "~/@/lib/strategies/backtest-copy";
import type { BacktestRunView } from "~/@/lib/strategies/map-backtest";
import { AssumptionsList } from "~/@/components/strategies/assumptions-list";
import { CoveragePanel } from "~/@/components/strategies/coverage-panel";
import { MonthlyReturnsTable } from "~/@/components/strategies/monthly-returns-table";
import { RunIdentity } from "~/@/components/strategies/run-identity";
import { SensitivityTable } from "~/@/components/strategies/sensitivity-table";
import { getBacktestRun } from "~/app/actions/strategies/getBacktestRun";
import { bailOnEmptyRender } from "~/app/actions/config";
import { BacktestPanel } from "./backtest-panel";

// The Backtest tab (design 1.5, PR-19): the published run of the live version. ISR
// (the segment's layout owns the params), one cached read per hour, shared with the
// Overview's evidence card. No searchParams are read here: the window and the
// resolution are read client-side by the panel, under its own Suspense boundary.
//
// Indexing follows 10.1: the page is indexable only for a published run with at
// least 60 sessions in its since-May-2019 window. Every other state (run required,
// running, not computable, or a run too short to judge) is noindex, follow, so a
// crawler never indexes a state card as if it were a result.
export const revalidate = 3600;
export const maxDuration = 60;

interface PageProps {
  params: Promise<{ strategy: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { strategy: slug } = await params;
  const seo = getStrategy(slug);
  if (!seo) notFound();
  const url = `${siteConfig.url}/strategies/${seo.slug}/backtest`;
  const title = `Backtest: ${seo.h1}`;
  const description = `The growth, drawdown, monthly returns, coverage and execution assumptions behind the ${seo.h1}, as its published run tests them against the ASX 200 total return.`;
  const image = {
    url: `/strategies/${seo.slug}/opengraph-image`,
    width: 1200,
    height: 630,
    alt: `${seo.h1} backtest, on Shorted`,
  };
  const run = await getBacktestRun(seo.slug);
  // A page that is not indexable says so; an indexable one sets no robots key at
  // all, so the root layout's directives are kept (Next merges metadata key by key).
  const robots =
    run && isIndexableBacktest(run.state, run.windows)
      ? {}
      : { robots: { index: false, follow: true } };
  return {
    title,
    description,
    ...robots,
    alternates: {
      canonical: url,
      languages: { "en-AU": url, "x-default": url },
    },
    openGraph: {
      title: `${title} | ${siteConfig.name}`,
      description,
      url,
      siteName: siteConfig.name,
      type: "website",
      locale: "en_AU",
      images: [image],
    },
    twitter: {
      site: "@shorted___",
      creator: "@shorted___",
      card: "summary_large_image",
      title,
      description,
      images: [image.url],
    },
  };
}

export default async function StrategyBacktestPage({ params }: PageProps) {
  const { strategy: slug } = await params;
  const seo = getStrategy(slug);
  if (!seo) notFound();

  const run = await getBacktestRun(seo.slug);
  // A failed read must not bake an empty tab into the route cache (60 s, not an hour).
  if (!run) await bailOnEmptyRender();

  const pageUrl = `${siteConfig.url}/strategies/${seo.slug}/backtest`;
  const breadcrumbs = [
    { name: "Home", url: siteConfig.url },
    { name: "Strategies", url: `${siteConfig.url}/strategies` },
    { name: seo.h1, url: `${siteConfig.url}/strategies/${seo.slug}` },
    { name: "Backtest", url: pageUrl },
  ];

  return (
    <>
      <BreadcrumbListSchema items={breadcrumbs} />
      {!run ? (
        <section className="rounded-lg border border-border/60 bg-card p-6 text-sm text-muted-foreground">
          The backtest for this strategy is temporarily unavailable; it refreshes automatically. Not financial advice.
        </section>
      ) : run.state === "published" || run.state === "approximate" ? (
        <PublishedBacktest slug={seo.slug} strategyId={seo.slug} strategyName={seo.h1} run={run} />
      ) : (
        <StateCard slug={seo.slug} run={run} />
      )}
    </>
  );
}

function PublishedBacktest({
  slug,
  strategyId,
  strategyName,
  run,
}: {
  slug: string;
  strategyId: string;
  strategyName: string;
  run: BacktestRunView;
}) {
  const recipe = run.recipe;
  const identity = run.identity;
  return (
    <div className="space-y-10">
      {identity ? <RunIdentity identity={identity} inputChangeNote={run.inputChangeNote} /> : null}

      <BacktestPanel
        strategyId={strategyId}
        run={run}
        main={
          <div className="space-y-12">
            <section aria-labelledby="monthly-heading" className="space-y-3">
              <h2 id="monthly-heading" className={sectionTitle}>Monthly returns</h2>
              <MonthlyReturnsTable monthly={run.monthly} strategyName={strategyName} />
            </section>

            <CoveragePanel
              years={run.coverageByYear}
              months={run.coverageMonthly}
              survivorship={run.survivorship}
              dataNotes={run.dataNotes}
            />

            <section aria-labelledby="sensitivity-heading" className="space-y-3">
              <h2 id="sensitivity-heading" className={sectionTitle}>Sensitivity runs</h2>
              <SensitivityTable rows={run.sensitivity} />
            </section>

            {run.replayAgreement ? (
              <p className="text-sm text-muted-foreground">{run.replayAgreement}</p>
            ) : null}
          </div>
        }
        sidebar={
          <div className="space-y-6">
            {recipe ? (
              <section aria-labelledby="assumptions-heading" className="space-y-3">
                <h2 id="assumptions-heading" className={sectionTitle}>Execution assumptions</h2>
                <AssumptionsList recipe={recipe} />
              </section>
            ) : null}
            <p className="text-sm">
              <a href="#coverage" className="font-medium text-primary hover:underline">
                Full recipe &amp; data coverage →
              </a>
            </p>
            <p className="rounded-md border border-accent/60 bg-accent/10 p-3 text-sm">
              {VARIANT_CALLOUT_COPY}
            </p>
            <Link
              href={strategyTabHref(slug, "trades")}
              prefetch={false}
              className="inline-flex w-full items-center justify-center rounded-md border border-border/70 px-4 py-2 text-sm font-medium hover:bg-muted/40"
            >
              Inspect trades
            </Link>
          </div>
        }
      />
    </div>
  );
}

/** The four non-published states, each in its own words (1.7). */
function StateCard({ slug, run }: { slug: string; run: BacktestRunView }) {
  const version = run.liveVersion;
  let headline: string;
  let body: string | null = null;
  switch (run.state) {
    case "run_required":
      headline = runRequiredCopy(version?.label ?? "", version?.rulesHash ?? "", run.stateReason);
      break;
    case "running":
      headline = runningCopy(run.runningSince);
      break;
    case "not_computable":
      headline = run.fiscalLabel
        ? notComputableHeadline(run.fiscalLabel)
        : notComputableNoLabel(run.computableSharePct);
      body = run.fiscalLabel ? NOT_COMPUTABLE_BODY : null;
      break;
    default:
      headline = "The backtest for this strategy is not available yet.";
  }
  return (
    <section aria-labelledby="backtest-state" className="space-y-3 rounded-lg border border-border/60 bg-card p-6">
      <h2 id="backtest-state" className={sectionTitle}>Backtest</h2>
      <p className="text-sm">{headline}</p>
      {body ? <p className="text-sm text-muted-foreground">{body}</p> : null}
      <p className="text-sm">
        <Link href={strategyTabHref(slug, "overview")} prefetch={false} className="text-primary hover:underline">
          Back to the strategy
        </Link>
      </p>
    </section>
  );
}
