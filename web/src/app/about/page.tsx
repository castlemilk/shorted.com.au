import { type Metadata } from "next";
import { getStatisticsWithCache } from "~/lib/statistics";
import AboutClient from "./about-client";
import { type AboutPageStatistics } from "~/lib/statistics";
import { siteConfig } from "~/@/config/site";
import { EnhancedOrganizationSchema } from "~/@/components/seo/enhanced-structured-data";

const TITLE = "About Shorted — Company, Founder & ASX Short Data Platform";
const DESCRIPTION =
  "Shorted.com.au is an independent Melbourne-built fintech platform, founded by Ben Ebsworth, that turns ASIC short position data into charts, alerts and an API. Free to use, with Premium and API plans.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  keywords: [
    "about Shorted",
    "Shorted.com.au founder",
    "Ben Ebsworth",
    "ASX short selling data",
    "ASIC short positions",
    "Australian fintech startup",
    "short interest tracker",
    "ASX short data API",
  ],
  authors: [{ name: siteConfig.founder.name, url: siteConfig.founder.website }],
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: `${siteConfig.url}/about`,
    siteName: siteConfig.name,
    type: "website",
    locale: "en_AU",
  },
  twitter: {
    site: "@shorted___",
    creator: "@shorted___",
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
  alternates: {
    canonical: `${siteConfig.url}/about`,
  },
};

const aboutPageSchema = {
  "@context": "https://schema.org",
  "@type": "AboutPage",
  name: TITLE,
  description: DESCRIPTION,
  url: `${siteConfig.url}/about`,
  inLanguage: "en-AU",
  about: { "@type": "Organization", name: siteConfig.name, url: siteConfig.url },
  mainEntity: {
    "@type": "Person",
    name: siteConfig.founder.name,
    jobTitle: siteConfig.founder.jobTitle,
    url: `${siteConfig.url}${siteConfig.founder.profilePath}`,
    image: siteConfig.founder.image,
    worksFor: { "@type": "Organization", name: siteConfig.name, url: siteConfig.url },
    sameAs: [
      siteConfig.founder.website,
      siteConfig.founder.linkedin,
      siteConfig.founder.github,
    ],
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

  return (
    <>
      <EnhancedOrganizationSchema />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(aboutPageSchema) }}
      />
      <AboutClient initialStatistics={statistics} />
    </>
  );
}
