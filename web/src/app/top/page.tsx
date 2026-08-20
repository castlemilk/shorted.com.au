import { type Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { siteConfig } from "~/@/config/site";
import {
  DatasetStructuredData,
  ItemListStructuredData,
  BreadcrumbListSchema,
} from "~/@/components/seo/enhanced-structured-data";
import { getTopPageData } from "../actions/top/getTopPageData";
import { type TimePeriod } from "~/@/lib/shorts-calculations";
import { TopPageSkeleton } from "./components/top-page-skeleton";
import { ReportsBanner } from "~/@/components/reports/reports-banner";
import { LatestWeeklyReportLink } from "~/@/components/reports/latest-weekly-report-link";
import { sectionTitle } from "~/@/lib/typography";

// Dynamic import for client component to reduce initial bundle
import dynamic from "next/dynamic";

const TopPageClient = dynamic(() => import("./top-page-client").then(mod => mod.TopPageClient), {
  loading: () => <TopPageSkeleton />,
  ssr: true,
});

const DEFAULT_PERIOD: TimePeriod = "3m";
const INITIAL_LOAD = 100;

/**
 * Latest ASIC report date actually present in the rendered data.
 *
 * Deliberately NOT `pageData.lastUpdated`: that helper falls back to
 * `new Date()` when the series is empty, which would put TODAY in the title —
 * impossible under T+4 and the exact class of bug this page is fixing.
 * Returns null when no dated point exists, and the title goes undated.
 */
function latestDataDate(
  timeSeries: Array<{ points?: Array<{ timestamp?: string }> }>,
): Date | null {
  let latest = 0;
  for (const series of timeSeries) {
    for (const point of series.points ?? []) {
      if (!point.timestamp) continue;
      const ms = new Date(point.timestamp).getTime();
      if (Number.isFinite(ms) && ms > latest) latest = ms;
    }
  }
  return latest > 0 ? new Date(latest) : null;
}

function formatAsAt(date: Date): string {
  return date.toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Australia/Sydney",
  });
}

// A dated title is the differentiator in this SERP — the incumbents rank with
// undated ones. Built from the ACTUAL latest ASIC date in the data the page
// renders (same cached accessor, so no extra backend call), never from
// `new Date()`. Falls back to a shorter undated title if the data is
// unavailable at metadata time.
export async function generateMetadata(): Promise<Metadata> {
  let title = "Most Shorted ASX Stocks — Top 100 ASIC Short Positions | Shorted";
  try {
    const pageData = await getTopPageData(DEFAULT_PERIOD, INITIAL_LOAD);
    const asAt = latestDataDate(pageData.timeSeries);
    if (asAt) {
      title = `Most Shorted ASX Stocks — as at ${formatAsAt(asAt)} | Shorted`;
    }
  } catch {
    // Keep the undated fallback title.
  }

  return {
    // `absolute` on purpose: the root template already appends "| Shorted",
    // and these titles carry their own suffix.
    title: { absolute: title },
    description:
      "The most shorted stocks on the ASX today. Live top 100 short interest rankings from official ASIC short position data, updated daily — track short %, weekly changes, and full history since 2010.",
    keywords: [
      "most shorted ASX stocks",
      "most shorted stocks Australia",
      "ASX short interest",
      "ASX short interest rankings",
      "ASIC short position data",
      "top shorted ASX stocks",
      "top 100 shorted stocks",
      "short selling Australia",
      "most shorted ASX companies",
      "short squeeze candidates ASX",
      "heavily shorted Australian stocks",
    ],
    openGraph: {
      title: "Most Shorted ASX Stocks — Top 100 Short Positions | Shorted",
      description:
        "Live rankings of the most shorted stocks on the Australian Securities Exchange. Official ASIC data with T+4 delay.",
      url: `${siteConfig.url}/top`,
      siteName: siteConfig.name,
      type: "website",
      locale: "en_AU",
      // No `images` key: this route ships its own data-driven
      // opengraph-image.tsx; an explicit `images` would shadow it.
    },
    twitter: {
      site: "@shorted___",
      creator: "@shorted___",
      card: "summary_large_image",
      title: "Most Shorted ASX Stocks — Top 100 Short Positions",
      description:
        "Live rankings of the most shorted ASX stocks. Official ASIC data updated daily.",
    },
    alternates: {
      canonical: `${siteConfig.url}/top`,
      languages: {
        "en-AU": `${siteConfig.url}/top`,
        "en": `${siteConfig.url}/top`,
        "x-default": `${siteConfig.url}/top`,
      },
    },
  };
}

// Event-driven ISR: 24h safety net, busted on-demand by the daily sync
// (POST /api/revalidate?path=/top&flush=shorts) when ASIC data changes.
export const revalidate = 86400;

// Breadcrumbs for structured data
const breadcrumbs = [
  { name: "Home", url: siteConfig.url },
  { name: "Top Shorted Stocks", url: `${siteConfig.url}/top` },
];

async function TopPageData() {
  const pageData = await getTopPageData(DEFAULT_PERIOD, INITIAL_LOAD);

  return (
    <>
      {/* ItemList structured data for individual stocks - helps Google index each stock */}
      <ItemListStructuredData
        name="Top 20 Most Shorted ASX Stocks"
        description="Live rankings of the top 20 most shorted stocks on the Australian Securities Exchange, updated daily from official ASIC short position data."
        items={pageData.stockListItems.map((stock) => ({
          name: `${stock.productCode} - ${stock.name}`,
          url: stock.url,
          description: `${stock.productCode} has a short position of ${stock.shortPercentage.toFixed(2)}% (Rank #${stock.rank})`,
        }))}
      />

      {/* Dynamic Dataset structured data with actual last updated date */}
      <DatasetStructuredData
        datasetInfo={{
          name: "Top 100 Most Shorted ASX Stocks",
          description:
            "Daily rankings of the most shorted stocks on the Australian Securities Exchange, sourced from official ASIC short position reports.",
          url: `${siteConfig.url}/top`,
          dateModified: pageData.lastUpdated,
        }}
      />

      <TopPageClient
        initialData={pageData.timeSeries}
        initialMoversData={pageData.movers}
        initialPeriod={DEFAULT_PERIOD}
        dataAsOf={pageData.lastUpdated}
      />

      {/* Crawlable evergreen copy + internal-link mesh. Server-rendered on
          purpose: this is the head-term hub page, so the explanatory text
          and links to the sibling short-selling surfaces must not depend on
          client JS. */}
      <section
        aria-labelledby="about-short-interest"
        className="container mx-auto px-4 py-12 border-t border-border/40"
      >
        <div className="max-w-3xl space-y-4">
          <h2 id="about-short-interest" className={sectionTitle}>
            About ASX short interest data
          </h2>
          <p className="text-muted-foreground leading-relaxed">
            Short interest measures the percentage of a company&apos;s issued
            shares that have been sold short and not yet covered. Every
            trading day, ASIC aggregates the short positions reported by
            institutional investors and publishes them with a four
            trading-day delay (T+4) — the rankings above always reflect the
            most recent official report. Shorted tracks these positions for
            every ASX-listed security, with full history back to 2010.
          </p>
          <p className="text-muted-foreground leading-relaxed">
            A high short percentage signals that professional investors are
            positioned for the price to fall — but heavily shorted stocks can
            also snap upward violently when shorts rush to cover. Track those
            setups on the{" "}
            <Link href="/battlegrounds" className="text-primary hover:underline">
              short squeeze candidates radar
            </Link>
            , see market-wide totals on the{" "}
            <Link href="/statistics" className="text-primary hover:underline">
              ASX short selling statistics
            </Link>{" "}
            page, or dig into any ticker&apos;s full short interest history
            via the rankings above.
          </p>
          <p className="text-muted-foreground leading-relaxed">
            New to shorting?{" "}
            <Link
              href="/learn/how-to-short-the-asx"
              className="text-primary hover:underline"
            >
              How to short the ASX
            </Link>{" "}
            covers brokers, instruments and costs, and the{" "}
            <Link href="/reports" className="text-primary hover:underline">
              weekly short selling reports
            </Link>{" "}
            analyse each week&apos;s biggest moves. Raw data downloads and
            the free API live on the{" "}
            <Link href="/data" className="text-primary hover:underline">
              open data hub
            </Link>
            .
          </p>
        </div>
      </section>
    </>
  );
}

export default function TopPage() {
  return (
    <main className="min-h-screen bg-background" aria-label="Top 100 Most Shorted ASX Stocks">
      {/* Structured Data for SEO */}
      <BreadcrumbListSchema items={breadcrumbs} />

      <div className="container mx-auto px-4 pt-4">
        <ReportsBanner />
        {/* Server-rendered link to the CURRENT latest weekly report. Distinct
            from ReportsBanner above it, which is a dismissible client banner
            pointing at the /reports hub with a generic anchor — this carries
            the dated, descriptive anchor the weekly series needs, is in the
            SSR DOM for crawlers, and cannot be dismissed away.

            Streamed under Suspense so its (cached, 1h) ListReports fetch can
            never delay this page's ISR shell, and it renders nothing at all
            if the archive is unavailable. */}
        <Suspense fallback={null}>
          <LatestWeeklyReportLink className="mb-6" />
        </Suspense>
      </div>

      <Suspense fallback={<TopPageSkeleton />}>
        <TopPageData />
      </Suspense>
    </main>
  );
}
