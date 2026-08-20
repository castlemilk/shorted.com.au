import { type Metadata } from "next";
import { getStatisticsWithCache } from "~/lib/statistics";
import AboutClient from "./about-client";
import { type AboutPageStatistics } from "~/lib/statistics";
import { siteConfig } from "~/@/config/site";

export const metadata: Metadata = {
  title: "About Shorted - ASX Short Position & Industry Intelligence",
  description:
    "Learn about Shorted.com.au, Australia's short position intelligence platform for daily ASIC data, industry crowding signals, top stocks, and alerts.",
  keywords: [
    "about Shorted",
    "ASX short selling data",
    "ASIC short positions",
    "industry intelligence",
    "ASX industry short interest",
    "Australian stock market",
    "short interest tracker",
    "free stock data Australia",
  ],
  openGraph: {
    title: "About Shorted - ASX Short Position & Industry Intelligence",
    description:
      "Learn about Shorted.com.au, Australia's short position platform for ASIC-backed stock and industry intelligence.",
    url: `${siteConfig.url}/about`,
    siteName: siteConfig.name,
    type: "website",
    locale: "en_AU",
  },
  twitter: {
    site: "@shorted___",
    creator: "@shorted___",
    card: "summary_large_image",
    title: "About Shorted - ASX Short Position & Industry Intelligence",
    description:
      "Learn about Shorted.com.au, Australia's short position platform for stock and industry intelligence.",
  },
  alternates: {
    canonical: `${siteConfig.url}/about`,
  },
};

// Allow page to be cached but revalidated periodically
// This ensures the static shell is cached, while the data is fetched fresh periodically
export const revalidate = 60;

// Fallback statistics for when API is unavailable (preview mode, offline, etc.)
const FALLBACK_STATISTICS: AboutPageStatistics = {
  companyCount: 500,
  industryCount: 25,
  latestUpdateDate: null,
};

// Timeout for the statistics fetch (4 seconds to leave margin for Vercel's 10s limit)
const STATISTICS_TIMEOUT_MS = 4000;

/**
 * Fetch statistics with a timeout to ensure the page renders quickly
 */
async function getStatisticsWithTimeout(): Promise<AboutPageStatistics> {
  return new Promise((resolve) => {
    // Set a timeout to return fallback stats
    const timeoutId = setTimeout(() => {
      console.warn("Statistics fetch timed out, using fallback");
      resolve(FALLBACK_STATISTICS);
    }, STATISTICS_TIMEOUT_MS);

    // Try to fetch real stats
    getStatisticsWithCache()
      .then(({ data }) => {
        clearTimeout(timeoutId);
        // Validate the data - use fallback if we got zeros
        if (data.companyCount > 0) {
          resolve(data);
        } else {
          resolve(FALLBACK_STATISTICS);
        }
      })
      .catch((error) => {
        clearTimeout(timeoutId);
        console.error("Failed to fetch statistics for about page:", error);
        resolve(FALLBACK_STATISTICS);
      });
  });
}

export default async function Page() {
  // Use timeout-protected fetch to ensure page always renders quickly
  const statistics = await getStatisticsWithTimeout();

  return <AboutClient initialStatistics={statistics} />;
}
