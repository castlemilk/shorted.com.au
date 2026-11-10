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
import type { BacktestRunView, BacktestWindowId, PaperTrackView } from "~/@/lib/strategies/map-backtest";
import { DEFAULT_BACKTEST_WINDOW, orderedWindows } from "~/@/lib/strategies/backtest-windows";
import { firstNonEmpty } from "~/@/lib/strategies/format";
import { APPROXIMATE_CHIP, inSampleChip, recordedFromCopy } from "~/@/lib/strategies/backtest-copy";
import { nextDay } from "~/@/lib/strategies/backtest-series";
import { coverageChip, coverageMeasureName, coverageMeasureOf, fragileChips } from "~/@/lib/strategies/backtest-tables";
import { AssumptionsList } from "~/@/components/strategies/assumptions-list";
import { CoveragePanel } from "~/@/components/strategies/coverage-panel";
import { MonthlyReturnsTable } from "~/@/components/strategies/monthly-returns-table";
import { RunIdentity } from "~/@/components/strategies/run-identity";
import { SensitivityTable } from "~/@/components/strategies/sensitivity-table";
import { getBacktestRun } from "~/app/actions/strategies/getBacktestRun";
import { getStrategies } from "~/app/actions/getStrategies";
import { getStrategyEvidence } from "~/app/actions/strategies/getStrategyEvidence";
import type { UniverseKind } from "~/@/lib/strategies/map-backtest";
import { universeLabel } from "~/@/lib/strategies/backtest-copy";
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

  const [run, catalogue, evidence] = await Promise.all([
    getBacktestRun(seo.slug),
    getStrategies(),
    getStrategyEvidence(),
  ]);
  // A failed read must not bake an empty tab into the route cache (60 s, not an hour).
  if (!run) await bailOnEmptyRender();
  // The label is the live version's universe_kind (from the evidence read); the registry's sentence
  // is its title. When a read fails the label is omitted, never a degraded text cached for an hour.
  const universeKind = evidence?.strategies.find((s) => s.strategyId === seo.slug)?.universeKind ?? "";
  const universeTitle = catalogue?.strategies.find((strategy) => strategy.id === seo.slug)?.metadata?.universe ?? "";

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
        <PublishedBacktest slug={seo.slug} strategyName={seo.h1} run={run} universeKind={universeKind} universeTitle={universeTitle} />
      ) : (
        <StateCard slug={seo.slug} run={run} />
      )}
    </>
  );
}

function PublishedBacktest({
  slug,
  strategyName,
  run,
  universeKind,
  universeTitle,
}: {
  slug: string;
  strategyName: string;
  run: BacktestRunView;
  universeKind: UniverseKind | "";
  universeTitle: string;
}) {
  const identity = run.identity;
  const recipe = run.recipe;
  const measure = coverageMeasureOf(run.survivorship?.measurement);
  // The chart's monthly strip reads the same measure as the table and the chip (one measure).
  const coverageMonthly = run.coverageMonthly.map((m) =>
    measure === "all_reported"
      ? { month: m.month, coveragePct: m.allReportedPct, measurable: m.allReportedMeasurable }
      : { month: m.month, coveragePct: m.coveragePct, measurable: m.measurable },
  );
  const liveVersion = run.liveVersion ?? identity?.version ?? null;
  const subtitle = [
    liveVersion ? `Rules ${liveVersion.label} (${liveVersion.rulesHash.slice(0, 8)})` : "",
    identity?.recipeId ? `Recipe ${identity.recipeId}${identity.recipeHash ? ` (${identity.recipeHash.slice(0, 8)})` : ""}` : "",
    identity?.engineVersion ? `engine ${identity.engineVersion}` : "",
    "Long only",
  ].filter(Boolean).join(" · ");
  const liveFrom = identity?.inSampleUntil ? nextDay(identity.inSampleUntil) : "";
  const chips = [
    coverageChip(run.coverageByYear, measure),
    run.state === "approximate" ? APPROXIMATE_CHIP : "",
    "Hypothetical · after costs",
    ...fragileChips(run.sensitivity),
  ].filter(Boolean);
  const windows = orderedWindows(run.windows);
  const paper = livePaper(run);

  return (
    <div className="space-y-10">
      <p className="font-mono text-xs text-muted-foreground" data-subtitle>{subtitle}</p>
      <BacktestPanel
        strategyId={slug}
        urlWindow=""
        served={(run.windowId as BacktestWindowId) || DEFAULT_BACKTEST_WINDOW}
        servedSeries={run.series}
        windows={windows}
        universeLabel={universeLabel(universeKind)}
        universeTitle={universeTitle}
        chips={chips}
        frozenChip={liveFrom ? inSampleChip(liveFrom) : "In-sample backtest"}
        recordedChip={recordedFromCopy(run.paperStart)}
        disclosures={run.disclosures}
        liveFrom={liveFrom}
        recordedFrom={run.paperStart}
        engineSegments={run.paperEngineSegments}
        coverageMonthly={coverageMonthly}
        coverageLabel={coverageMeasureName(measure)}
        benchmarkName={firstNonEmpty(identity?.benchmark, "S&P/ASX 200 Gross Total Return (XJT)")}
        referenceName={firstNonEmpty(identity?.referenceName, "same-data reference")}
        paper={paper}
        avgHoldSessions={run.tradeSummary?.avgHoldSessions ?? null}
        identity={identity ? <RunIdentity identity={identity} inputChangeNote={run.inputChangeNote} /> : null}
        main={
          <div className="space-y-12">
            <section aria-labelledby="monthly-heading" className="space-y-3">
              <h2 id="monthly-heading" className={sectionTitle}>Monthly returns</h2>
              <MonthlyReturnsTable
                monthly={run.monthly}
                strategyName={strategyName}
                windowStart={identity?.windowStart ?? ""}
                windowEnd={identity?.windowEnd ?? ""}
              />
            </section>

            <CoveragePanel
              years={run.coverageByYear}
              months={run.coverageMonthly}
              survivorship={run.survivorship}
              dataQuality={run.dataQuality}
              dataNotes={run.dataNotes}
            />
            {identity ? (
              <dl className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-x-4 gap-y-1 font-mono text-xs" data-coverage-identity>
                {identity.inputHash ? (
                  <>
                    <dt className="text-muted-foreground">Input hash</dt>
                    <dd className="break-all">{identity.inputHash}</dd>
                  </>
                ) : null}
                {identity.outputHash ? (
                  <>
                    <dt className="text-muted-foreground">Output hash</dt>
                    <dd className="break-all">{identity.outputHash}</dd>
                  </>
                ) : null}
                {run.inputChangeNote ? (
                  <>
                    <dt className="text-muted-foreground">Since the previous run</dt>
                    <dd>{run.inputChangeNote}</dd>
                  </>
                ) : null}
              </dl>
            ) : null}

            <section aria-labelledby="sensitivity-heading" className="space-y-3">
              <h2 id="sensitivity-heading" className={sectionTitle}>Sensitivity runs</h2>
              <SensitivityTable rows={run.sensitivity} baseBeatsXjt={baseBeatsXjt(run)} recipe={recipe} />
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

/** Whether the base run beats XJT over its full window (the sensitivity column's words). */
function baseBeatsXjt(run: BacktestRunView): boolean | null {
  const full = run.windows.find((w) => w.window === "since_2019_05");
  if (full?.cagrPct == null || full.benchmarkCagrPct == null) return null;
  return full.cagrPct > full.benchmarkCagrPct;
}

/** The paper track for the run summary: its real first session, and the too-short rule (5.9). */
function livePaper(run: BacktestRunView): PaperTrackView | null {
  const live = run.windows.find((w) => w.window === "live");
  if (!live || live.sessions === 0 || !run.paperStart) return null;
  return {
    since: nextDay(run.identity?.inSampleUntil ?? ""),
    recordedFrom: run.paperStart,
    sessions: live.sessions,
    closedTrades: live.closedTrades,
    openPositions: 0,
    returnPct: live.totalReturnPct,
    tooShort: live.sessions < 63 || live.closedTrades < 10,
    engineSegments: run.paperEngineSegments,
  };
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
      {/* The state's headline is the tab's section heading: the page's outline is h1 (layout), h2 (this). */}
      <h2 id="backtest-state" className={sectionTitle}>{headline}</h2>
      {body ? <p className="text-sm text-muted-foreground">{body}</p> : null}
      <p className="text-sm">
        <Link href={strategyTabHref(slug, "overview")} prefetch={false} className="text-primary hover:underline">
          Back to the strategy
        </Link>
      </p>
    </section>
  );
}
