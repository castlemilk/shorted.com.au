import { type Metadata } from "next";
import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { StocksSearchClient } from "./components/stocks-search-client";
import { siteConfig } from "~/@/config/site";

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
      <StocksSearchClient popularStocks={POPULAR_STOCKS} />
    </DashboardLayout>
  );
}
