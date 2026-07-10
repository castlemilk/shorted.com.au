import { type Metadata } from "next";
import { Suspense } from "react";
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

// Dynamic import for client component to reduce initial bundle
import dynamic from "next/dynamic";

const TopPageClient = dynamic(() => import("./top-page-client").then(mod => mod.TopPageClient), {
  loading: () => <TopPageSkeleton />,
  ssr: true,
});

const DEFAULT_PERIOD: TimePeriod = "3m";
const INITIAL_LOAD = 100;

export const metadata: Metadata = {
  title: "Top 100 Most Shorted ASX Stocks",
  description:
    "Live rankings of the top 100 most shorted stocks on the ASX. Official ASIC short position data updated daily with T+4 delay. Track short interest %, weekly changes, and historical trends.",
  keywords: [
    "top shorted ASX stocks",
    "most shorted stocks Australia",
    "ASX short interest rankings",
    "ASIC short position data",
    "top 100 shorted stocks",
    "ASX bearish stocks",
    "short selling Australia",
    "most shorted ASX companies",
    "short squeeze candidates ASX",
    "heavily shorted Australian stocks",
  ],
  openGraph: {
    title: "Top 100 Most Shorted ASX Stocks | Shorted",
    description:
      "Live rankings of the most shorted stocks on the Australian Securities Exchange. Official ASIC data with T+4 delay.",
    url: `${siteConfig.url}/top`,
    siteName: siteConfig.name,
    type: "website",
    locale: "en_AU",
    images: [
      {
        url: siteConfig.ogImage,
        width: 1200,
        height: 630,
        alt: "Top 100 Most Shorted ASX Stocks - Official ASIC Data",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Top 100 Most Shorted ASX Stocks",
    description:
      "Live rankings of the most shorted ASX stocks. Official ASIC data updated daily.",
    images: [siteConfig.ogImage],
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
          dateModified: pageData.lastUpdated,
        }}
      />

      <TopPageClient
        initialData={pageData.timeSeries}
        initialMoversData={pageData.movers}
        initialPeriod={DEFAULT_PERIOD}
      />
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
      </div>

      <Suspense fallback={<TopPageSkeleton />}>
        <TopPageData />
      </Suspense>
    </main>
  );
}
