import { type Metadata } from "next";
import { siteConfig } from "~/@/config/site";
import { getStatisticsWithCache } from "~/lib/statistics";
import { type AboutPageStatistics } from "~/lib/statistics";
import TechnologyClient from "./technology-client";

export const metadata: Metadata = {
  title: "Technology — AI-Native Architecture | Shorted",
  description:
    "Explore the AI and cloud-native technology powering Shorted.com.au. Built on GCP Cloud Run, Gemini AI, and Go microservices to deliver real-time ASX short position intelligence.",
  keywords: [
    "AI stock analysis",
    "Gemini AI",
    "GCP Cloud Run",
    "Go microservices",
    "real-time data pipeline",
    "ASX short selling technology",
    "financial data platform",
  ],
  openGraph: {
    title: "Technology — AI-Native Architecture | Shorted",
    description:
      "Explore the AI and cloud-native technology powering Shorted.com.au.",
    url: `${siteConfig.url}/technology`,
    siteName: siteConfig.name,
    type: "website",
    locale: "en_AU",
  },
  twitter: {
    card: "summary_large_image",
    title: "Technology — AI-Native Architecture | Shorted",
    description:
      "Explore the AI and cloud-native technology powering Shorted.com.au.",
  },
  alternates: {
    canonical: `${siteConfig.url}/technology`,
  },
};

export const revalidate = 60;

const FALLBACK_STATISTICS: AboutPageStatistics = {
  companyCount: 500,
  industryCount: 25,
  latestUpdateDate: null,
};

const STATISTICS_TIMEOUT_MS = 4000;

async function getStatisticsWithTimeout(): Promise<AboutPageStatistics> {
  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      resolve(FALLBACK_STATISTICS);
    }, STATISTICS_TIMEOUT_MS);

    getStatisticsWithCache()
      .then(({ data }) => {
        clearTimeout(timeoutId);
        if (data.companyCount > 0) {
          resolve(data);
        } else {
          resolve(FALLBACK_STATISTICS);
        }
      })
      .catch(() => {
        clearTimeout(timeoutId);
        resolve(FALLBACK_STATISTICS);
      });
  });
}

export default async function Page() {
  const statistics = await getStatisticsWithTimeout();
  return <TechnologyClient statistics={statistics} />;
}
