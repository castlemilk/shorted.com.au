import { type Metadata } from "next";
import dynamic from "next/dynamic";
import Link from "next/link";
import { FileText, ChevronRight } from "lucide-react";
import { siteConfig } from "~/@/config/site";
import { cn } from "~/@/lib/utils";
import { pageTitle, sectionTitle, eyebrow } from "~/@/lib/typography";
import { weeklyReportPath } from "~/@/lib/reports/weekly-slug";
import { Suspense } from "react";
import { HomeContent } from "./home-content";
import { TopShortsFallback } from "./top-shorts-fallback";
import {
  AsicDataFreshness,
  latestAsicDataDate,
} from "~/@/components/home/asic-data-freshness";
import { toJson } from "@bufbuild/protobuf";
import { getTopShortsData } from "~/app/actions/getTopShorts";
import { getIndustryTreeMap } from "~/app/actions/getIndustryTreeMap";
import { TimeSeriesDataSchema, IndustryTreeMapSchema } from "~/gen/stocks/v1alpha1/stocks_pb";
import type { ViewMode } from "~/gen/shorts/v1alpha1/market_pb";

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
import { HomepageFaq } from "~/@/components/home/homepage-faq";
import { Disclosure } from "~/@/components/ui/disclosure";
import { PremiumUpsellBanner } from "~/@/components/premium/premium-upsell-banner";
import { getEnhancedWeeklyReportData, getAvailableWeekSlugs } from "~/app/actions/reports/getReportData";
import { BrowseByIndustry } from "./browse-by-industry";
import { TrendingThisWeek } from "./trending-this-week";
import { ShortFlowNarrative } from "./short-flow-narrative";
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
  // absolute: the root layout template is `%s | Shorted` and fullTitle already
  // carries the brand suffix — without absolute the page renders "… | Shorted | Shorted".
  title: { absolute: siteConfig.fullTitle },
  description: siteConfig.description,
  keywords: siteConfig.keywords,
  openGraph: {
    title: siteConfig.socialTitle,
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
    site: siteConfig.twitterHandle,
    creator: siteConfig.twitterHandle,
    title: siteConfig.socialTitle,
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
  const [topShorts, initialTreeMap] = await Promise.all([
    getTopShortsData("3m", 10, 0).catch(() => undefined),
    getIndustryTreeMap("3m", 8, 0 as ViewMode)
      .then((tm) => (tm ? toJson(IndustryTreeMapSchema, tm) : undefined))
      .catch(() => undefined),
  ]);
  // Degraded fetch paths (KV fallbacks) can leave null/undefined holes in
  // timeSeries; toJson(schema, undefined) throws and kills the prerender of
  // "/" (it failed the 2026-08-20 release-candidate build). Filter holes and
  // treat any serialization failure as "no prefetch" — the widgets then fetch
  // client-side, which is strictly better than a failed build.
  let initialTopShorts;
  try {
    initialTopShorts = topShorts?.timeSeries
      ?.filter((d) => d != null)
      .map((d) => toJson(TimeSeriesDataSchema, d));
  } catch {
    initialTopShorts = undefined;
  }
  // Same series, reused for the visible "as at" stamp that now sits directly
  // above the charts — no extra RPC and, unlike a Suspense boundary, nothing
  // that can stream in late and push the charts down.
  const asicAsOf = latestAsicDataDate(topShorts?.timeSeries);

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
        title="Most Shorted ASX Stocks — Official ASIC Short Selling Data"
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

      {/* Page header with SEO-optimized content. The hero is deliberately
          compact on phones: the charts are the product, and every hero pixel
          pushes the first chart below the fold. The lede is clamped visually
          but stays complete in the server HTML for crawlers. */}
      <header className="container mx-auto px-4 pt-4 pb-2 sm:pt-8 sm:pb-4">
        <h1 className={cn(pageTitle, "text-2xl leading-tight sm:text-4xl")}>
          Shorting the ASX: Australia&apos;s Most Shorted Stocks, from Official
          ASIC Data
        </h1>
        <p className="text-muted-foreground mt-2 max-w-2xl text-sm line-clamp-3 sm:text-base sm:line-clamp-none">
          Everything you need to track shorting on the ASX — official ASIC short
          selling data updated daily with T+4 delay. Follow the most shorted ASX
          stocks, analyze short interest trends, and explore industry heatmaps.
        </p>
      </header>

      {/* The charts' heading + freshness stamp. Rendered here, synchronously,
          so the h2 sits with the charts it labels instead of a section of its
          own — and so nothing streams in between it and <HomeContent>. */}
      <div className="container mx-auto px-4">
        <h2 className={cn(sectionTitle, "text-xl sm:text-2xl")}>
          Most Shorted ASX Stocks
        </h2>
        <AsicDataFreshness
          date={asicAsOf}
          className="mt-0.5 text-xs text-muted-foreground sm:text-sm"
        />
      </div>

      {/* Interactive dashboard content */}
      <HomeContent
        initialTopShorts={initialTopShorts}
        initialTreeMap={initialTreeMap}
      />

      {/* Breaking News - Price Sensitive Announcements. Below the charts: it
          is ssr:false, so rendering it above meant it popped in after
          hydration and shoved the charts down. */}
      <BreakingNewsBanner />

      {/* Latest Weekly Report Banner — streamed via Suspense */}
      <Suspense fallback={null}>
        <WeeklyReportBanner />
      </Suspense>

      {/* Premium upsell for authenticated free-tier users */}
      <Suspense fallback={null}>
        <PremiumUpsellBanner />
      </Suspense>

      {/* Market news — freshest cross-market coverage, directly under the
          dashboard and ahead of everything editorial */}
      <Suspense fallback={null}>
        <LatestMarketNews />
      </Suspense>

      {/* Trending This Week — biggest short position changes */}
      <Suspense fallback={null}>
        <TrendingThisWeek />
      </Suspense>

      {/* Auto-generated building/covering prose — daily-changing indexable
          text from the same cached 1w movers data TrendingThisWeek uses */}
      <Suspense fallback={null}>
        <ShortFlowNarrative />
      </Suspense>

      {/* Browse by Industry — server-rendered for SEO internal linking */}
      <Suspense fallback={null}>
        <BrowseByIndustry />
      </Suspense>

      {/* Macro dashboards — cross-links to the housing + economy surfaces */}
      <section className="container mx-auto px-4 py-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Link
            href="/economy"
            className="group rounded-xl border border-border bg-card p-5 transition-colors hover:border-primary/50"
          >
            <p className={eyebrow}>Macro dashboard</p>
            <h2 className="mt-1 font-serif text-xl font-semibold">
              Australian economy
              <ChevronRight className="ml-1 inline h-4 w-4 opacity-0 transition-opacity group-hover:opacity-100" />
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Interactive state map — unemployment, trade, state final demand and
              fuel, with cash rate and CPI. ABS, RBA and DCCEEW open data.
            </p>
          </Link>
          <Link
            href="/housing"
            className="group rounded-xl border border-border bg-card p-5 transition-colors hover:border-primary/50"
          >
            <p className={eyebrow}>Macro dashboard</p>
            <h2 className="mt-1 font-serif text-xl font-semibold">
              House prices tracker
              <ChevronRight className="ml-1 inline h-4 w-4 opacity-0 transition-opacity group-hover:opacity-100" />
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              National and suburb-level prices, demographics and drilldown maps
              from ABS and RBA data.
            </p>
          </Link>
        </div>
      </section>

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

      {/* Background copy, collapsed. Native <details> keeps every word in the
          server-rendered HTML for crawlers while the page ends on links
          rather than three paragraphs of prose. */}
      <section className="container mx-auto px-4 py-6">
        <h2 className={cn(sectionTitle, "mb-2")}>
          About this data
        </h2>
        <div className="rounded-lg border border-border/60 px-4">
          <Disclosure
            title={
              <h3 className="text-sm font-semibold text-foreground">
                Where the data comes from
              </h3>
            }
            hint="Official ASIC reports"
          >
            <p>
              All short position data is sourced directly from ASIC (Australian
              Securities and Investments Commission) daily reports. We track over
              4,500 ASX-listed securities with historical data from 2010 to
              present — the top 100 short positions on the ASX, with interactive
              historical charts and industry sector breakdowns.
            </p>
          </Disclosure>
          <Disclosure
            title={
              <h3 className="text-sm font-semibold text-foreground">
                Why the data is 4 trading days old
              </h3>
            }
            hint="T+4 reporting delay"
          >
            <p>
              ASIC publishes short position data with a 4 trading day delay to
              balance market transparency with preventing potential manipulation.
              Data shown reflects positions from 4 trading days ago, not
              real-time figures.
            </p>
          </Disclosure>
          <Disclosure
            title={
              <h3 className="text-sm font-semibold text-foreground">
                What you can do here
              </h3>
            }
            hint="Charts, screeners and reports"
          >
            <p>
              View interactive historical charts, industry heatmaps, and weekly
              reports. Screen stocks by short interest, days to cover, director
              trades, and news sentiment. Track short interest trends, identify
              heavily shorted companies, and monitor bearish sentiment across the
              Australian market.
            </p>
          </Disclosure>
        </div>
        {/* Kept OUT of the expanders: internal links should stay visible.
            Descriptive anchors, plain prose, zero client JS. */}
        <p className="mt-4 text-sm text-muted-foreground">
          Go deeper:{" "}
          <Link
            href="/statistics"
            className="underline underline-offset-4 hover:text-foreground"
          >
            ASX short selling statistics — total dollars shorted
          </Link>
          ,{" "}
          <Link
            href="/scans"
            className="underline underline-offset-4 hover:text-foreground"
          >
            daily short interest scans
          </Link>
          , the{" "}
          <Link
            href="/top"
            className="underline underline-offset-4 hover:text-foreground"
          >
            top 100 most shorted ASX stocks
          </Link>
          , or the{" "}
          <Link
            href="/shorts"
            className="underline underline-offset-4 hover:text-foreground"
          >
            full list of ASX short positions
          </Link>
          .
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          New to this?{" "}
          <Link
            href="/learn"
            className="underline underline-offset-4 hover:text-foreground"
          >
            Learn how short selling works on the ASX
          </Link>
          , keep the{" "}
          <Link
            href="/glossary"
            className="underline underline-offset-4 hover:text-foreground"
          >
            short selling glossary
          </Link>{" "}
          handy, then read the{" "}
          <Link
            href="/reports"
            className="underline underline-offset-4 hover:text-foreground"
          >
            weekly ASX short selling reports
          </Link>
          .
        </p>
      </section>

      {/* Server-rendered crawlable table of the top 100 short positions.
          Screen-reader-only and position-independent for crawlers, so it sits
          at the foot of the page rather than above the charts. */}
      <Suspense fallback={null}>
        <TopShortsFallback />
      </Suspense>

      {/* Homepage FAQ — question-form headings + FAQPage JSON-LD */}
      <HomepageFaq />
    </main>
  );
}
