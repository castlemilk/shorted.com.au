import { type Metadata } from "next";
import { Suspense } from "react";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { StocksSearchClient } from "./components/stocks-search-client";
import { CompanyDirectory } from "./components/company-directory";
import { siteConfig } from "~/@/config/site";
import { cn } from "~/@/lib/utils";
import { pageTitle, eyebrow, lede } from "~/@/lib/typography";

export const metadata: Metadata = {
  title: "ASX Stock Search - Find Short Positions by Company",
  description:
    "Search 2,200+ ASX-listed stocks and view their short selling positions. Find company short interest data, historical trends, and market analysis for any Australian stock.",
  keywords: [
    "ASX stock search",
    "Australian stocks",
    "short position lookup",
    "ASX company search",
    "stock analysis Australia",
    "find ASX stocks",
    "short selling search",
  ],
  openGraph: {
    title: "ASX Stock Search - Find Short Positions by Company",
    description:
      "Search 2,200+ ASX-listed stocks and view their short selling positions and market analysis.",
    url: `${siteConfig.url}/stocks`,
    siteName: siteConfig.name,
    type: "website",
    locale: "en_AU",
  },
  twitter: {
    card: "summary_large_image",
    title: "ASX Stock Search - Find Short Positions",
    description:
      "Search 2,200+ ASX-listed stocks and view their short selling positions.",
  },
  alternates: {
    canonical: `${siteConfig.url}/stocks`,
  },
};

// Public page for SEO — revalidate every hour
export const revalidate = 3600;

// Popular ASX stocks for quick access (pre-rendered on server)
const POPULAR_STOCKS = [
  { code: "CBA", name: "Commonwealth Bank", sector: "Banking" },
  { code: "BHP", name: "BHP Group", sector: "Mining" },
  { code: "CSL", name: "CSL Limited", sector: "Healthcare" },
  { code: "WBC", name: "Westpac", sector: "Banking" },
  { code: "ANZ", name: "ANZ Bank", sector: "Banking" },
  { code: "NAB", name: "National Australia Bank", sector: "Banking" },
  { code: "WOW", name: "Woolworths", sector: "Retail" },
  { code: "WES", name: "Wesfarmers", sector: "Conglomerate" },
  { code: "RIO", name: "Rio Tinto", sector: "Mining" },
  { code: "TLS", name: "Telstra", sector: "Telecom" },
  { code: "XRO", name: "Xero", sector: "Technology" },
  { code: "MQG", name: "Macquarie Group", sector: "Financial" },
];

export default function StocksPage() {
  return (
    <DashboardLayout>
      {/* SSR, crawlable page header — the single h1 for the directory/search
          surface. Kept server-side so the heading is present for anonymous
          and crawler traffic even before the search client hydrates. */}
      <header className="mb-8 border-b border-border/60 pb-6">
        <p className={cn(eyebrow, "text-primary font-medium")}>
          Company Directory
        </p>
        <h1 className={cn(pageTitle, "mt-2")}>ASX Company Directory</h1>
        <p className={cn(lede, "text-base")}>
          Search 2,200+ ASX-listed companies and open any stock&apos;s short
          selling position, historical trend and market data — sourced from
          official ASIC short position reports.
        </p>
      </header>
      <Suspense fallback={<div className="h-96 animate-pulse rounded bg-muted" />}>
        <StocksSearchClient popularStocks={POPULAR_STOCKS} />
      </Suspense>
      {/* Server-rendered directory: real company list + logos below the
          search box (crawlable /shorts/* links; search stays interactive) */}
      <Suspense fallback={<div className="mt-8 h-64 animate-pulse rounded bg-muted" />}>
        <CompanyDirectory />
      </Suspense>
    </DashboardLayout>
  );
}
