import { type Metadata } from "next";
import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { getTopShortsData } from "../actions/getTopShorts";
import { calculateMovers, type TimePeriod } from "@/lib/shorts-calculations";
import { TopShortsClient } from "./components/top-shorts-client";

// ISR: Revalidate every 5 minutes (short interest data updates frequently)
export const revalidate = 300;

// Metadata for SEO
export const metadata: Metadata = {
  title: "Top Shorted Stocks | Shorted",
  description:
    "View the biggest movers in short positions on the ASX. Track stocks with the largest increases, decreases, and volatility in short interest across different time periods.",
  keywords: [
    "short interest",
    "shorted stocks",
    "ASX shorts",
    "short position changes",
    "stock volatility",
    "short interest movers",
  ],
  openGraph: {
    title: "Top Shorted Stocks on the ASX",
    description:
      "Track the biggest movers in short positions with real-time data across multiple timeframes.",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Top Shorted Stocks | Shorted",
    description:
      "View the biggest movers in short positions on the ASX with real-time analysis.",
  },
};

const DEFAULT_PERIOD: TimePeriod = "3m";
const LOAD_CHUNK_SIZE = 20;

export default async function TopShortsPage() {
  // Check authentication (backup - middleware should catch this)
  const session = await auth();
  if (!session) {
    redirect("/signin?callbackUrl=/shorts");
  }

  // Fetch initial data on server
  const data = await getTopShortsData(DEFAULT_PERIOD, LOAD_CHUNK_SIZE, 0);

  // Calculate movers on server (this is heavy computation, good to do server-side)
  const initialMoversData = calculateMovers(data.timeSeries, DEFAULT_PERIOD);

  return (
    <TopShortsClient
      initialMoversData={initialMoversData}
      initialPeriod={DEFAULT_PERIOD}
    />
  );
}
