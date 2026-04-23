import { type MetadataRoute } from "next";
import { siteConfig } from "~/@/config/site"
import { getAllPosts } from "~/@/lib/api";
import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";
import { getAllIndustrySlugs } from "./actions/industry/getIndustryData";
import { getAllTermSlugs } from "~/@/data/glossary-terms";
import {
  getAvailableWeekSlugs,
  getAvailableMonthSlugs,
  getAvailableYearSlugs,
} from "./actions/reports/getReportData";

// Educational articles for sitemap
const learnArticles = [
  "what-is-short-selling",
  "understanding-t4-delay",
  "how-to-read-short-interest",
  "short-squeeze-mechanics",
  "risk-management-shorted-stocks",
  "sector-analysis-short-selling",
  "building-a-watchlist",
  "asx-short-selling-history",
  "securities-lending-explained",
  "short-selling-vs-put-options",
  "reading-short-interest-changes",
];

// API URL for sitemap generation during builds
const API_URL =
  process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://localhost:9091";

// API response type for top shorts
interface TopShortsResponse {
  timeSeries: Array<{ productCode?: string }>;
}

// Popular stock codes as fallback when API is unavailable
const FALLBACK_STOCK_CODES = [
  "CBA", "BHP", "CSL", "NAB", "WBC", "ANZ", "WES", "MQG", "WOW", "TLS",
  "RIO", "FMG", "GMG", "TCL", "WDS", "NCM", "ALL", "COL", "REA", "QBE",
];

/**
 * Fetch all stock codes from the API for the sitemap.
 * Uses direct fetch to avoid protobuf-es SSR initialization issues.
 * Falls back to popular stock codes if API is unavailable.
 */
async function getAllStockCodes(): Promise<string[]> {
  try {
    const baseUrl =
      process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT ??
      process.env.NEXT_PUBLIC_API_URL ??
      API_URL;

    // Use direct fetch with JSON to avoid protobuf-es SSR issues
    const response = await fetch(
      `${baseUrl}/shorts.v1alpha1.ShortedStocksService/GetTopShorts`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          period: "1y",
          limit: 1000,
          offset: 0,
          summaryOnly: true,
        }),
        next: { revalidate: 3600 }, // Cache for 1 hour
      }
    );

    if (!response.ok) {
      console.warn(`Sitemap API returned ${response.status}, using fallback stocks`);
      return FALLBACK_STOCK_CODES;
    }

    const data = (await response.json()) as TopShortsResponse;

    // Extract unique stock codes from the response
    const stockCodes = (data.timeSeries || [])
      .map((ts) => ts.productCode)
      .filter((code): code is string => typeof code === "string" && code.length > 0);

    return stockCodes.length > 0 ? [...new Set(stockCodes)] : FALLBACK_STOCK_CODES;
  } catch (error) {
    console.error("Failed to fetch stock codes for sitemap:", error);
    return FALLBACK_STOCK_CODES;
  }
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const baseUrl = siteConfig.url;
  const currentDate = new Date().toISOString();

  // Static routes
  const staticRoutes: MetadataRoute.Sitemap = [
    { url: baseUrl, lastModified: currentDate },
    { url: `${baseUrl}/about`, lastModified: currentDate },
    { url: `${baseUrl}/blog`, lastModified: currentDate },
    { url: `${baseUrl}/terms`, lastModified: currentDate },
    { url: `${baseUrl}/roadmap`, lastModified: currentDate },
    { url: `${baseUrl}/pricing`, lastModified: currentDate },
    { url: `${baseUrl}/developer`, lastModified: currentDate },
    { url: `${baseUrl}/technology`, lastModified: currentDate },
    { url: `${baseUrl}/methodology`, lastModified: currentDate },
    { url: `${baseUrl}/disclaimer`, lastModified: currentDate },
  ];

  // Blog post routes
  const posts = getAllPosts();
  const blogRoutes = posts.map((post) => ({
    url: `${baseUrl}/blog/${post.slug}`,
    lastModified: post.date,
  }));

  // Dynamically fetch all stock codes from the API
  const stockCodes = await getAllStockCodes();

  const stockRoutes = stockCodes.map((code) => ({
    url: `${baseUrl}/shorts/${code}`,
    lastModified: currentDate,
  }));

  // Canonical listing is /shorts; /stocks is not a canonical index.
  const shortsRoutes = [
    { url: `${baseUrl}/shorts`, lastModified: currentDate },
  ];

  // Documentation routes for LLMs and developers
  const docRoutes = [
    {
      url: `${baseUrl}/docs/llm-context`,
      lastModified: currentDate,
    },
    {
      url: `${baseUrl}/docs/llm-context-raw`,
      lastModified: currentDate,
    },
    {
      url: `${baseUrl}/docs/api-reference`,
      lastModified: currentDate,
    },
  ];

  // Industry pages - index + individual industry pages
  let industrySlugs: string[] = [];
  try {
    industrySlugs = await getAllIndustrySlugs();
  } catch (error) {
    console.error("Failed to fetch industry slugs for sitemap:", error);
  }

  const industryRoutes = [
    {
      url: `${baseUrl}/industry`,
      lastModified: currentDate,
    },
    ...industrySlugs.map((slug) => ({
      url: `${baseUrl}/industry/${slug}`,
      lastModified: currentDate,
    })),
  ];

  // Glossary pages - index + individual terms
  const termSlugs = getAllTermSlugs();
  const glossaryRoutes = [
    {
      url: `${baseUrl}/glossary`,
      lastModified: currentDate,
    },
    ...termSlugs.map((slug) => ({
      url: `${baseUrl}/glossary/${slug}`,
      lastModified: currentDate,
    })),
  ];

  // Directory pages - index + per-letter
  const letters = "abcdefghijklmnopqrstuvwxyz".split("");
  const directoryRoutes = [
    {
      url: `${baseUrl}/directory`,
      lastModified: currentDate,
    },
    ...letters.map((letter) => ({
      url: `${baseUrl}/directory/${letter}`,
      lastModified: currentDate,
    })),
  ];

  // Market snapshot pages
  let marketDates: string[] = [];
  try {
    const transport = createConnectTransport({
      baseUrl:
        process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT ??
        process.env.NEXT_PUBLIC_API_URL ??
        API_URL,
    });
    const client = createClient(ShortedStocksService, transport);
    const response = await client.getAvailableDates({ limit: 90, before: "" });
    marketDates = response.dates;
  } catch (error) {
    console.error("Failed to fetch market dates for sitemap:", error);
  }

  const marketRoutes = [
    {
      url: `${baseUrl}/market`,
      lastModified: currentDate,
    },
    ...marketDates.map((date) => ({
      url: `${baseUrl}/market/${date}`,
      lastModified: currentDate,
    })),
  ];

  // Report pages
  let weekSlugs: string[] = [];
  let monthSlugs: string[] = [];
  let yearSlugs: string[] = [];
  try {
    weekSlugs = await getAvailableWeekSlugs();
    monthSlugs = await getAvailableMonthSlugs();
    yearSlugs = await getAvailableYearSlugs();
  } catch (error) {
    console.error("Failed to fetch report slugs for sitemap:", error);
  }

  // Historical reports have fixed publish dates; derive lastmod from slug so
  // older reports don't churn their lastmod on every regeneration.
  const weeklyLastMod = (slug: string): string => {
    // Supports "2026-W17" or "2026-17"
    const m = /^(\d{4})-W?(\d{1,2})$/.exec(slug);
    if (!m) return currentDate;
    const year = parseInt(m[1]!, 10);
    const week = parseInt(m[2]!, 10);
    // ISO week 1 = the week containing Jan 4. Approximate to Monday of that week + 5 days (Saturday).
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const jan4Day = jan4.getUTCDay() || 7;
    const mondayWeek1 = new Date(jan4);
    mondayWeek1.setUTCDate(jan4.getUTCDate() - (jan4Day - 1));
    const target = new Date(mondayWeek1);
    target.setUTCDate(mondayWeek1.getUTCDate() + (week - 1) * 7 + 5);
    return target.toISOString();
  };
  const monthlyLastMod = (slug: string): string => {
    const m = /^(\d{4})-(\d{1,2})$/.exec(slug);
    if (!m) return currentDate;
    const year = parseInt(m[1]!, 10);
    const month = parseInt(m[2]!, 10);
    // First day of the following month
    return new Date(Date.UTC(year, month, 1)).toISOString();
  };
  const yearlyLastMod = (slug: string): string => {
    const m = /^(\d{4})$/.exec(slug);
    if (!m) return currentDate;
    return new Date(Date.UTC(parseInt(m[1]!, 10) + 1, 0, 1)).toISOString();
  };

  const reportRoutes = [
    { url: `${baseUrl}/reports`, lastModified: currentDate },
    ...weekSlugs.map((slug) => ({
      url: `${baseUrl}/reports/weekly/${slug}`,
      lastModified: weeklyLastMod(slug),
    })),
    ...monthSlugs.map((slug) => ({
      url: `${baseUrl}/reports/monthly/${slug}`,
      lastModified: monthlyLastMod(slug),
    })),
    ...yearSlugs.map((slug) => ({
      url: `${baseUrl}/reports/yearly/${slug}`,
      lastModified: yearlyLastMod(slug),
    })),
  ];

  // FAQ page
  const faqRoutes = [
    {
      url: `${baseUrl}/faq`,
      lastModified: currentDate,
    },
  ];

  // Privacy page
  const privacyRoutes = [
    {
      url: `${baseUrl}/privacy`,
      lastModified: currentDate,
    },
  ];

  // Educational content hub
  const learnRoutes = [
    {
      url: `${baseUrl}/learn`,
      lastModified: currentDate,
    },
    ...learnArticles.map((slug) => ({
      url: `${baseUrl}/learn/${slug}`,
      lastModified: currentDate,
    })),
  ];

  // Top page (high priority landing page)
  const topRoutes = [
    {
      url: `${baseUrl}/top`,
      lastModified: currentDate,
    },
  ];

  // Screener page (query param presets excluded — not indexable)
  const screenerRoutes = [
    {
      url: `${baseUrl}/screener`,
      lastModified: currentDate,
    },
  ];

  return [
    ...staticRoutes,
    ...topRoutes,
    ...shortsRoutes,
    ...industryRoutes,
    ...glossaryRoutes,
    ...directoryRoutes,
    ...marketRoutes,
    ...reportRoutes,
    ...faqRoutes,
    ...privacyRoutes,
    ...learnRoutes,
    ...docRoutes,
    ...screenerRoutes,
    ...blogRoutes,
    ...stockRoutes,
  ];
}
