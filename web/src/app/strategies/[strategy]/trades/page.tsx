import { type Metadata } from "next";
import { notFound } from "next/navigation";

import { sectionTitle } from "~/@/lib/typography";
import { siteConfig } from "~/@/config/site";
import { BreadcrumbListSchema } from "~/@/components/seo/enhanced-structured-data";
import { getStrategy } from "~/@/lib/strategies/registry";
import { TradesSummary } from "~/@/components/strategies/trades-summary";
import { getBacktestRun } from "~/app/actions/strategies/getBacktestRun";
import { bailOnEmptyRender } from "~/app/actions/config";
import { TradesIsland } from "./trades-island";

// The Trades tab (design 1.5, 2.2, PR-19): the public summary of the live run's
// trades, and, for a signed-in reader, the list itself. ISR like the other tabs:
// the summary is the same for every caller, and the list is read by an island
// through a server action that is never cached. No searchParams are read here.
//
// Noindex, follow (10.1): the trade list is a working surface, and its summary is
// on the Backtest page, which is the indexable one.
export const revalidate = 3600;
export const maxDuration = 60;

interface PageProps {
  params: Promise<{ strategy: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { strategy: slug } = await params;
  const seo = getStrategy(slug);
  if (!seo) notFound();
  const url = `${siteConfig.url}/strategies/${seo.slug}/trades`;
  const title = `Trades: ${seo.h1}`;
  const description = `Every trade the ${seo.h1} takes in its published backtest, with the signal, the entry, the exit reason and the net return.`;
  return {
    title,
    description,
    robots: { index: false, follow: true },
    alternates: { canonical: url },
    openGraph: {
      title: `${title} | ${siteConfig.name}`,
      description,
      url,
      siteName: siteConfig.name,
      type: "website",
      locale: "en_AU",
    },
  };
}

export default async function StrategyTradesPage({ params }: PageProps) {
  const { strategy: slug } = await params;
  const seo = getStrategy(slug);
  if (!seo) notFound();

  const run = await getBacktestRun(seo.slug);
  if (!run) await bailOnEmptyRender();
  const published = run?.state === "published" || run?.state === "approximate";
  const runId = published ? (run?.identity?.runId ?? 0) : 0;
  const exitReasons = Object.keys(run?.tradeSummary?.exitsByReason ?? {});

  return (
    <div className="space-y-10">
      <BreadcrumbListSchema
        items={[
          { name: "Home", url: siteConfig.url },
          { name: "Strategies", url: `${siteConfig.url}/strategies` },
          { name: seo.h1, url: `${siteConfig.url}/strategies/${seo.slug}` },
          { name: "Trades", url: `${siteConfig.url}/strategies/${seo.slug}/trades` },
        ]}
      />
      {!run ? (
        <section className="rounded-lg border border-border/60 bg-card p-6 text-sm text-muted-foreground">
          The trades for this strategy are temporarily unavailable; they refresh automatically. Not financial advice.
        </section>
      ) : !published || !run.tradeSummary ? (
        <section className="rounded-lg border border-border/60 bg-card p-6 text-sm text-muted-foreground">
          {run.stateReason || "No published backtest, so no trades to show yet."}
        </section>
      ) : (
        <>
          <section aria-labelledby="trade-summary-heading" className="space-y-3">
            <h2 id="trade-summary-heading" className={sectionTitle}>Trade summary</h2>
            <TradesSummary summary={run.tradeSummary} />
            <p className="text-xs text-muted-foreground">
              In-sample trades of the published run. Hypothetical results from rules applied to historical data, not a record of trading. Not financial advice.
            </p>
          </section>
          <TradesIsland runId={runId} exitReasons={exitReasons} />
        </>
      )}
    </div>
  );
}
