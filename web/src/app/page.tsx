import { type Metadata } from "next";
import dynamic from "next/dynamic";
import Link from "next/link";
import { FileText, ChevronRight } from "lucide-react";
import { siteConfig } from "~/@/config/site";
import { cn } from "~/@/lib/utils";
import { pageTitle, eyebrow } from "~/@/lib/typography";
import { weeklyReportPath } from "~/@/lib/reports/weekly-slug";
import { Suspense } from "react";
import { HomeContent } from "./home-content";
import { TopShortsFallback } from "./top-shorts-fallback";
import { toJson } from "@bufbuild/protobuf";
import { getTopShortsData } from "~/app/actions/getTopShorts";
import { getIndustryTreeMap } from "~/app/actions/getIndustryTreeMap";
import { TimeSeriesDataSchema, IndustryTreeMapSchema } from "~/gen/stocks/v1alpha1/stocks_pb";
import type { ViewMode } from "~/gen/shorts/v1alpha1/shorts_pb";

// Dynamic import to avoid SSR issues — component imports @connectrpc/connect
const BreakingNewsBanner = dynamic(
  () => import("~/@/components/ui/breaking-news-banner").then((m) => m.BreakingNewsBanner),
  { ssr: false }
);
import {
  DatasetStructuredData,
  EnhancedOrganizationSchema,
} from "~/@/components/seo/enhanced-structured-data";
import { LLMMeta } from "~/@/components/seo/llm-meta";
import { PremiumUpsellBanner } from "~/@/components/premium/premium-upsell-banner";
import { getEnhancedWeeklyReportData, getAvailableWeekSlugs } from "~/app/actions/reports/getReportData";
import { BrowseByIndustry } from "./browse-by-industry";
import { TrendingThisWeek } from "./trending-this-week";
import { LatestFromBlog } from "./latest-from-blog";
import { LatestMarketNews } from "./latest-market-news";
import { FeaturedStory } from "~/@/components/news/masthead/featured-story";
import { FEATURED } from "~/@/components/news/masthead/featured";

// Event-driven ISR: serve the cached page instantly and hold it for up to 24h
// as a safety net. The real refresh is on-demand — the daily ASIC sync busts
// this page (POST /api/revalidate?path=/&flush=shorts) only when data changes,
// so we're not blindly regenerating hourly for data that updates once a day.
export const revalidate = 86400;

export const metadata: Metadata = {
  title: siteConfig.fullTitle,
  description: siteConfig.description,
  keywords: siteConfig.keywords,
  openGraph: {
    title: siteConfig.fullTitle,
    description: siteConfig.description,
    url: siteConfig.url,
    siteName: siteConfig.name,
    type: "website",
    locale: "en_AU",
    images: [
      {
        url: siteConfig.ogImage,
        width: 1200,
        height: 630,
        alt: "Shorted - Official ASIC Short Position Data for ASX Stocks",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: siteConfig.fullTitle,
    description: siteConfig.description,
    images: [siteConfig.ogImage],
  },
  alternates: {
    canonical: siteConfig.url,
    languages: {
      "en-AU": siteConfig.url,
      "x-default": siteConfig.url,
    },
  },
};

function formatWeekTitle(slug: string): string {
  const match = slug.match(/^(\d{4})-W(\d{2})$/);
  if (!match?.[1] || !match[2]) return slug;
  return `Week ${parseInt(match[2])}, ${match[1]}`;
}

async function WeeklyReportBanner() {
  const availableSlugs = await getAvailableWeekSlugs();
  const candidates = availableSlugs.slice(0, 3);
  const results = await Promise.all(
    candidates.map((slug) => getEnhancedWeeklyReportData(slug))
  );

  let report: Awaited<ReturnType<typeof getEnhancedWeeklyReportData>> = null;
  let reportSlug = "";
  for (let i = 0; i < candidates.length; i++) {
    const result = results[i];
    const slug = candidates[i];
    if (result?.headline && slug) {
      report = result;
      reportSlug = slug;
      break;
    }
  }

  if (!report) return null;

  return (
    <div className="container mx-auto px-4 pb-4">
      <Link
        href={weeklyReportPath(reportSlug)}
        className="group block rounded-lg border border-primary/20 bg-gradient-to-r from-primary/5 to-primary/10 p-4 hover:border-primary/40 transition-colors"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <div className="p-2 bg-primary/10 rounded-md shrink-0">
              <FileText className="h-5 w-5 text-primary" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className={cn(eyebrow, "font-medium text-primary")}>
                  Latest Report
                </span>
                <span className="text-xs text-muted-foreground">
                  {formatWeekTitle(reportSlug)}
                </span>
              </div>
              <p className="text-sm font-medium truncate group-hover:text-primary transition-colors">
                {report.headline}
              </p>
              {report.summary && (
                <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
                  {report.summary}
                </p>
              )}
            </div>
          </div>
          <ChevronRight className="h-5 w-5 text-muted-foreground group-hover:text-primary transition-colors shrink-0 ml-2" />
        </div>
      </Link>
    </div>
  );
}

export default async function Page() {
  // Prefetch the homepage widgets server-side (the same queries TopShorts and
  // the IndustryTreeMap make on mount: "3m", 10 rows / 8 tiles, CURRENT_CHANGE)
  // and hand them to HomeContent as protobuf JSON (RSC-safe, no bigint across
  // the boundary). This removes the render->hydrate->fetch waterfall for both
  // lead widgets. Both actions are cached, so the TopShortsFallback call is free.
  const [initialTopShorts, initialTreeMap] = await Promise.all([
    getTopShortsData("3m", 10, 0)
      .then((res) => res?.timeSeries?.map((d) => toJson(TimeSeriesDataSchema, d)))
      .catch(() => undefined),
    getIndustryTreeMap("3m", 8, 0 as ViewMode)
      .then((tm) => (tm ? toJson(IndustryTreeMapSchema, tm) : undefined))
      .catch(() => undefined),
  ]);

  return (
    <main className="min-h-screen flex flex-col bg-transparent">
      {/* Structured Data for rich snippets and knowledge graph */}
      <DatasetStructuredData
        datasetInfo={{
          name: "ASIC Short Position Data for ASX Stocks",
          description:
            "Daily short selling position data for Australian Securities Exchange (ASX) listed companies, sourced from official ASIC reports. Covers 4,500+ stocks with data from 2010 to present.",
        }}
      />
      {/* WebSite schema comes from the sitewide block in layout.tsx — a second
          one here with a different SearchAction target confuses parsers. */}
      <EnhancedOrganizationSchema />
      <LLMMeta
        title="Shorted - Official ASIC Short Position Data for ASX Stocks"
        description="Track short selling positions on the ASX using official ASIC data. Free daily updates, interactive charts, industry heatmaps, and analysis of the most shorted Australian stocks."
        keywords={[
          "ASIC short position data",
          "ASX short positions",
          "most shorted ASX stocks",
          "short selling Australia",
          "ASX short interest",
        ]}
        dataSource="ASIC"
        dataFrequency="daily"
        content="homepage"
      />

      {/* Page header with SEO-optimized content */}
      <header className="container mx-auto px-4 pt-8 pb-4">
        <h1 className={pageTitle}>
          Shorting the ASX: Official Short Position Data from ASIC
        </h1>
        <p className="text-muted-foreground mt-2 max-w-2xl">
          Everything you need to track shorting on the ASX — official ASIC short
          selling data updated daily with T+4 delay. Follow the most shorted ASX
          stocks, analyze short interest trends, and explore industry heatmaps.
        </p>
        {/* Extended description for SEO - visually hidden but accessible */}
        <p className="sr-only">
          Shorted.com.au provides free daily short position data sourced directly from
          ASIC (Australian Securities and Investments Commission). View the top 100 most
          shorted stocks on the ASX, interactive historical charts, industry sector
          breakdowns, and comprehensive analysis. Data is updated daily with T+4 trading
          day delay as published by ASIC. Track short interest trends, identify heavily
          shorted companies, and monitor bearish sentiment across the Australian market.
        </p>
      </header>

      {/* Breaking News - Price Sensitive Announcements */}
      <div className="container mx-auto px-4 pb-4">
        <BreakingNewsBanner />
      </div>

      {/* Latest Weekly Report Banner — streamed via Suspense */}
      <Suspense fallback={null}>
        <WeeklyReportBanner />
      </Suspense>

      {/* Premium upsell for authenticated free-tier users */}
      <Suspense fallback={null}>
        <PremiumUpsellBanner />
      </Suspense>

      {/* SSR fallback table for search engine crawlability */}
      <Suspense fallback={null}>
        <TopShortsFallback />
      </Suspense>

      {/* Interactive dashboard content */}
      <HomeContent
        initialTopShorts={initialTopShorts}
        initialTreeMap={initialTreeMap}
      />

      {/* Market news — freshest cross-market coverage, directly under the
          dashboard and ahead of everything editorial */}
      <Suspense fallback={null}>
        <LatestMarketNews />
      </Suspense>

      {/* Trending This Week — biggest short position changes */}
      <Suspense fallback={null}>
        <TrendingThisWeek />
      </Suspense>

      {/* Browse by Industry — server-rendered for SEO internal linking */}
      <Suspense fallback={null}>
        <BrowseByIndustry />
      </Suspense>

      {/* Featured investigation — flagship editorial long-read */}
      {FEATURED[0] && (
        <div className="container mx-auto px-4 py-6">
          <FeaturedStory item={FEATURED[0]} />
        </div>
      )}

      {/* Latest from the blog — surfaces freshly published posts on the homepage */}
      <Suspense fallback={null}>
        <LatestFromBlog />
      </Suspense>

      {/* Visible intro for SEO — crawlable content explaining the platform */}
      <section className="container mx-auto px-4 py-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm text-muted-foreground">
          <div>
            <h2 className="text-sm font-semibold text-foreground mb-1">Official ASIC Data</h2>
            <p>
              All short position data is sourced directly from ASIC (Australian Securities
              and Investments Commission) daily reports. We track over 4,500 ASX-listed
              securities with historical data from 2010 to present.
            </p>
          </div>
          <div>
            <h2 className="text-sm font-semibold text-foreground mb-1">T+4 Trading Day Delay</h2>
            <p>
              ASIC publishes short position data with a 4 trading day delay to balance
              market transparency with preventing potential manipulation. Data shown
              reflects positions from 4 trading days ago, not real-time figures.
            </p>
          </div>
          <div>
            <h2 className="text-sm font-semibold text-foreground mb-1">Charts & Analysis</h2>
            <p>
              View interactive historical charts, industry heatmaps, and weekly reports.
              Screen stocks by short interest, days to cover, director trades, and news
              sentiment. Track the most shorted ASX stocks with daily updates.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
