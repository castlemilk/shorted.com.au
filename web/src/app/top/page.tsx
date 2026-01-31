import { type Metadata } from "next";
import { Suspense } from "react";
import { siteConfig } from "~/@/config/site";
import {
  FAQStructuredData,
  DatasetStructuredData,
  ItemListStructuredData,
  BreadcrumbListSchema,
} from "~/@/components/seo/enhanced-structured-data";
import { getTopPageData } from "../actions/top/getTopPageData";
import { type TimePeriod } from "~/@/lib/shorts-calculations";
import { TopPageSkeleton } from "./components/top-page-skeleton";

// Dynamic import for client component to reduce initial bundle
import dynamic from "next/dynamic";

const TopPageClient = dynamic(() => import("./top-page-client").then(mod => mod.TopPageClient), {
  loading: () => <TopPageSkeleton />,
  ssr: true,
});

const DEFAULT_PERIOD: TimePeriod = "3m";
const INITIAL_LOAD = 100;

export const metadata: Metadata = {
  title: "Top 100 Most Shorted ASX Stocks | Official ASIC Data",
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

// FAQ data for rich snippets
const topPageFAQs = [
  {
    question: "What are the most shorted stocks on the ASX right now?",
    answer:
      "The most shorted ASX stocks change daily based on ASIC reports. Common heavily shorted sectors include lithium miners, retail, and speculative growth stocks. This page shows the live top 100 most shorted stocks updated daily from official ASIC data.",
  },
  {
    question: "How is short interest percentage calculated?",
    answer:
      "Short interest percentage is calculated by dividing the total reported short positions by the total shares on issue, then multiplying by 100. ASIC requires market participants to report positions exceeding $100,000 or 0.01% of issued capital.",
  },
  {
    question: "What does high short interest indicate?",
    answer:
      "High short interest indicates that many investors are betting against a stock, expecting its price to fall. However, it can also signal a potential short squeeze if positive news causes short sellers to cover their positions rapidly.",
  },
  {
    question: "How often is this short position data updated?",
    answer:
      "Short position data is updated daily based on ASIC reports. ASIC publishes aggregated short positions with a T+4 trading day delay, meaning data reflects positions from 4 trading days prior.",
  },
];

// Revalidate every 10 minutes for fresh data (aligned with Redis cache TTL)
export const revalidate = 600;

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
      <FAQStructuredData faqs={topPageFAQs} />

      <Suspense fallback={<TopPageSkeleton />}>
        <TopPageData />
      </Suspense>
    </main>
  );
}
