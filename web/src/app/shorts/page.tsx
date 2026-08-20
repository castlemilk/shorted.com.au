import nextDynamic from "next/dynamic";
import { type Metadata } from "next";
import { getTopShortsData } from "../actions/getTopShorts";
import { calculateMovers, type TimePeriod } from "~/@/lib/shorts-calculations";
import { siteConfig } from "~/@/config/site";
import { BreadcrumbListSchema } from "~/@/components/seo/enhanced-structured-data";
import { ShortsListFallback } from "~/@/components/shorts-list-fallback";

// Dynamic import to avoid SSR issues — child imports @connectrpc/connect
const TopShortsClient = nextDynamic(
  () => import("./components/top-shorts-client").then((m) => m.TopShortsClient),
  { ssr: false }
);

export const metadata: Metadata = {
  title: "ASX Short Positions List & Short Interest Data",
  description:
    "Every ASX short position from official ASIC data in one sortable list. Track short interest for all Australian stocks, updated daily with T+4 delay.",
  keywords: [
    "ASX short positions list",
    "all shorted stocks ASX",
    "ASIC short selling data",
    "Australian short positions",
    "ASX bearish stocks",
    "short interest tracker",
    "ASX short selling list",
  ],
  openGraph: {
    title: "ASX Short Positions List & Short Interest Data | Shorted",
    description:
      "Every ASX short position from official ASIC data in one sortable list. Updated daily with T+4 delay.",
    url: `${siteConfig.url}/shorts`,
    siteName: siteConfig.name,
    type: "website",
    locale: "en_AU",
  },
  twitter: {
    site: "@shorted___",
    creator: "@shorted___",
    card: "summary_large_image",
    title: "ASX Short Positions List & Short Interest Data",
    description:
      "Every ASX short position from official ASIC data in one sortable list. Updated daily with T+4 delay.",
  },
  alternates: {
    canonical: `${siteConfig.url}/shorts`,
  },
};

const DEFAULT_PERIOD: TimePeriod = "3m";
const LOAD_CHUNK_SIZE = 20;

// Force dynamic rendering to avoid build-time prerendering (triggers Supabase circuit breaker)
export const dynamic = "force-dynamic";

// Revalidate every 10 minutes for fresh data
export const revalidate = 600;

// Breadcrumbs for structured data
const breadcrumbs = [
  { name: "Home", url: siteConfig.url },
  { name: "ASX Short Positions", url: `${siteConfig.url}/shorts` },
];

export default async function TopShortsPage() {
  // Fetch data on server — returns undefined if backend is unreachable (e.g. during build)
  const data = await getTopShortsData(DEFAULT_PERIOD, LOAD_CHUNK_SIZE, 0);
  const timeSeries = data?.timeSeries ?? [];
  const moversData = calculateMovers(timeSeries, DEFAULT_PERIOD);

  // Server-rendered fallback rows so crawlers see real data (the interactive
  // dashboard below is client-only via dynamic ssr:false).
  const fallbackStocks = timeSeries.map((ts) => ({
    code: ts.productCode,
    name: ts.name || ts.productCode,
    percent: ts.latestShortPosition,
  }));

  // ItemList schema — declares this URL as the canonical index for the
  // top shorted ASX stocks so crawlers + AI Overviews can ingest the
  // ranking as structured data alongside the rendered table.
  const itemList = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "ASX Short Positions — All Shorted Stocks",
    description:
      "Daily-updated rankings of ASX-listed stocks by ASIC-reported short interest %.",
    numberOfItems: timeSeries.length,
    url: `${siteConfig.url}/shorts`,
    itemListOrder: "https://schema.org/ItemListOrderDescending",
    isPartOf: {
      "@type": "WebSite",
      url: siteConfig.url,
      name: siteConfig.name,
    },
    itemListElement: timeSeries.slice(0, 20).map((ts, i) => ({
      "@type": "ListItem",
      position: i + 1,
      url: ts.productCode ? `${siteConfig.url}/shorts/${ts.productCode}` : undefined,
      name: ts.name || ts.productCode,
    })),
  };

  return (
    <>
      <BreadcrumbListSchema items={breadcrumbs} />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(itemList) }}
      />

      {/* Server-rendered header — the interactive dashboard below is
          client-only (ssr:false), so this is the indexable page intro. */}
      <header className="container mx-auto px-4 pt-6">
        <h1 className="text-3xl font-bold tracking-tight">
          ASX Short Positions — Full List
        </h1>
        <p className="mt-2 max-w-3xl text-muted-foreground">
          Every short position reported to ASIC across the Australian
          Securities Exchange, in one sortable list. Data comes from official
          ASIC short-position reports, updated daily with a T+4 delay, and
          covers every reported ASX stock. Use it to track short interest and
          see where short sellers are most active.
        </p>
      </header>

      {/* SSR fallback table (sr-only) so crawlers see real data rows */}
      <ShortsListFallback stocks={fallbackStocks} />

      <TopShortsClient
        initialMoversData={moversData}
        initialPeriod={DEFAULT_PERIOD}
      />
    </>
  );
}
