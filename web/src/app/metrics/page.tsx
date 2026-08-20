import { type Metadata } from "next";
import { siteConfig } from "~/@/config/site";
import { getStatisticsWithCache } from "~/lib/statistics";
import { type AboutPageStatistics } from "~/lib/statistics";
import MetricsClient from "./metrics-client";

export const metadata: Metadata = {
  title: "Metrics — Platform Traction & Growth",
  description:
    "See the numbers behind Shorted.com.au — companies tracked, data pipeline throughput, infrastructure scale, and growth metrics for Australia's short position intelligence platform.",
  keywords: [
    "Shorted metrics",
    "platform traction",
    "ASX data coverage",
    "short position data",
    "startup metrics",
    "data pipeline",
  ],
  openGraph: {
    title: "Metrics — Platform Traction & Growth",
    description:
      "See the numbers behind Shorted.com.au — companies tracked, data pipeline throughput, and infrastructure scale.",
    url: `${siteConfig.url}/metrics`,
    siteName: siteConfig.name,
    type: "website",
    locale: "en_AU",
  },
  twitter: {
    site: "@shorted___",
    creator: "@shorted___",
    card: "summary_large_image",
    title: "Metrics — Platform Traction & Growth",
    description:
      "See the numbers behind Shorted.com.au — companies tracked, data pipeline throughput, and infrastructure scale.",
  },
  alternates: {
    canonical: `${siteConfig.url}/metrics`,
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
  return <MetricsClient statistics={statistics} />;
}
