import nextDynamic from "next/dynamic";
import { type Metadata } from "next";
import { getTopShortsData } from "../actions/getTopShorts";
import { calculateMovers, type TimePeriod } from "~/@/lib/shorts-calculations";
import { siteConfig } from "~/@/config/site";

// Dynamic import to avoid SSR issues — child imports @connectrpc/connect
const TopShortsClient = nextDynamic(
  () => import("./components/top-shorts-client").then((m) => m.TopShortsClient),
  { ssr: false }
);

export const metadata: Metadata = {
  title: "ASX Short Positions List | All Shorted Stocks",
  description:
    "Complete list of all ASX short positions from official ASIC data. Browse short selling positions for every Australian stock with T+4 delay. Filter, sort and analyze short interest data.",
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
    title: "ASX Short Positions List | All Shorted Stocks",
    description:
      "Complete list of all ASX short positions from official ASIC data. Updated daily with T+4 delay.",
    url: `${siteConfig.url}/shorts`,
    siteName: siteConfig.name,
    type: "website",
    locale: "en_AU",
  },
  twitter: {
    card: "summary_large_image",
    title: "ASX Short Positions List | All Shorted Stocks",
    description:
      "Complete list of all ASX short positions from official ASIC data.",
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

export default async function TopShortsPage() {
  // Fetch data on server — returns undefined if backend is unreachable (e.g. during build)
  const data = await getTopShortsData(DEFAULT_PERIOD, LOAD_CHUNK_SIZE, 0);
  const timeSeries = data?.timeSeries ?? [];
  const moversData = calculateMovers(timeSeries, DEFAULT_PERIOD);

  return (
    <TopShortsClient
      initialMoversData={moversData}
      initialPeriod={DEFAULT_PERIOD}
    />
  );
}
