import nextDynamic from "next/dynamic";
import Link from "next/link";
import { type Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { BreadcrumbStructuredData } from "~/@/components/seo/breadcrumbs";
import { RegimeBanner } from "~/@/components/picks/regime-banner";
import {
  StrategyFitPanel,
  sortFitsByStrength,
} from "~/@/components/strategy/strategy-fit-panel";
import { formatDate } from "~/@/lib/fundamentals/format";
import { stockTabMetadata } from "~/@/lib/seo/stock-tab-metadata";
import { stockTabHref, stockTabLabel } from "~/@/lib/stocks/stock-tabs";
import {
  getStockStrategyFit,
  type StockStrategyFit,
} from "~/app/actions/getStockStrategyFit";
import { getStrategies } from "~/app/actions/getStrategies";
import { STOCK_CODE_PATTERN } from "../stock-page-shared";

// Client island: the chart reads prices through Connect-RPC, so it is
// client-only (as the chart in the layout is) and shares that chart's cached
// price queries.
const StrategyLevelsChart = nextDynamic(
  () =>
    import("~/@/components/strategy/strategy-levels-chart").then(
      (m) => m.StrategyLevelsChart,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="h-[360px] animate-pulse rounded-lg bg-muted/40" />
    ),
  },
);

// On-demand ISR: the empty generateStaticParams is what makes the segment
// statically optimisable; without it revalidate is inert (see the overview).
export const revalidate = 3600;
export const dynamicParams = true;
export function generateStaticParams(): Array<{ stockCode: string }> {
  return [];
}

interface PageProps {
  params: Promise<{ stockCode: string }>;
}

// One read per request shared by generateMetadata and the page. The action
// THROWS on failure; the page rethrows so a failed fit is never cached as an
// empty tab, and metadata fails open (no noindex) on the same failure.
const loadFit = cache(
  async (code: string): Promise<StockStrategyFit | null> => {
    try {
      return await getStockStrategyFit(code);
    } catch (err) {
      console.warn(`[strategy tab] strategy fit unavailable for ${code}:`, err);
      return null;
    }
  },
);

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const code = (await params).stockCode.toUpperCase();
  const fit = STOCK_CODE_PATTERN.test(code) ? await loadFit(code) : null;
  return stockTabMetadata({
    code,
    tab: "strategy",
    title: (company) =>
      `${code} Strategy Fit: Breakout, CANSLIM & Trend Rules | ${company}`,
    description: (company) =>
      `How ${company} (ASX:${code}) reads against the Zanger breakout, CAN SLIM, Minervini trend, crowded-short and quality-compounder rules today, with the levels drawn on the chart.`,
    keywords: [
      `${code} breakout`,
      `${code} CANSLIM`,
      `${code} trend template`,
      `${code} stock picker`,
    ],
    forceNoindex: fit !== null && !fit.inUniverse,
  });
}

export default async function StrategyPage({ params }: PageProps) {
  const code = (await params).stockCode.toUpperCase();
  if (!STOCK_CODE_PATTERN.test(code)) notFound();
  const [fit, strategies] = await Promise.all([loadFit(code), getStrategies()]);
  if (!fit) {
    throw new Error(
      `strategy fit unavailable for ${code}; failing ISR render instead of caching an empty tab`,
    );
  }
  const definitions = new Map(
    (strategies?.strategies ?? []).map((s) => [s.id, s]),
  );
  const ordered = sortFitsByStrength(fit.fits);
  const pricesTo = formatDate(fit.asOf);

  return (
    <>
      <BreadcrumbStructuredData
        items={[
          { label: "Stocks", href: "/stocks" },
          { label: code, href: stockTabHref(code, "overview") },
          {
            label: stockTabLabel("strategy"),
            href: stockTabHref(code, "strategy"),
          },
        ]}
      />
      <h1 className="sr-only">{code} strategy fit</h1>
      <div className="flex min-w-0 flex-col gap-4 md:gap-6">
        <RegimeBanner regime={fit.regime} />

        {!fit.inUniverse ? (
          <section
            aria-labelledby="not-evaluated-heading"
            className="rounded-lg border bg-card px-4 py-3 text-sm"
          >
            <h2 id="not-evaluated-heading" className="font-medium">
              Not evaluated yet
            </h2>
            <p className="mt-1 text-muted-foreground">
              The picker needs more price history for {code} than it holds today
              (about 40 sessions) before it can read any strategy. See what it
              does read on the{" "}
              <Link
                href="/picks"
                prefetch={false}
                className="text-primary hover:underline"
              >
                stock picker
              </Link>
              .
            </p>
          </section>
        ) : (
          <>
            {/* The chart prints no title of its own, so this heading names it. */}
            <section
              aria-labelledby="strategy-chart-heading"
              id="strategy-chart"
              className="flex flex-col gap-2"
            >
              <h2 id="strategy-chart-heading" className="text-sm font-medium">
                Levels on the chart
              </h2>
              <StrategyLevelsChart
                stockCode={code}
                fits={ordered}
                priceFeatures={fit.priceFeatures}
              />
            </section>
            {ordered.map((row) => (
              <StrategyFitPanel
                key={row.strategyId}
                fit={row}
                definition={definitions.get(row.strategyId) ?? null}
              />
            ))}
          </>
        )}

        <p className="text-[11px] text-muted-foreground">
          {pricesTo ? `Prices to ${pricesTo} · ` : ""}Mechanical readings of
          published rules, not recommendations ·{" "}
          <Link
            href="/disclaimer"
            prefetch={false}
            className="underline underline-offset-4 hover:text-foreground"
          >
            Not financial advice
          </Link>
        </p>
      </div>
    </>
  );
}
