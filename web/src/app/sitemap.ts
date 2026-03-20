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
    {
      url: baseUrl,
      lastModified: currentDate,
      changeFrequency: "daily",
      priority: 1.0,
    },
    {
      url: `${baseUrl}/about`,
      lastModified: currentDate,
      changeFrequency: "monthly",
      priority: 0.3,
    },
    {
      url: `${baseUrl}/blog`,
      lastModified: currentDate,
      changeFrequency: "weekly",
      priority: 0.6,
    },
    {
      url: `${baseUrl}/terms`,
      lastModified: currentDate,
      changeFrequency: "monthly",
      priority: 0.3,
    },
    {
      url: `${baseUrl}/roadmap`,
      lastModified: currentDate,
      changeFrequency: "monthly",
      priority: 0.3,
    },
    {
      url: `${baseUrl}/pricing`,
      lastModified: currentDate,
      changeFrequency: "monthly",
      priority: 0.3,
    },
  ];

  // Blog post routes
  const posts = getAllPosts();
  const blogRoutes = posts.map((post) => ({
    url: `${baseUrl}/blog/${post.slug}`,
    lastModified: post.date,
    changeFrequency: "weekly" as const,
    priority: 0.6,
  }));

  // Dynamically fetch all stock codes from the API
  const stockCodes = await getAllStockCodes();

  const stockRoutes = stockCodes.map((code) => ({
    url: `${baseUrl}/shorts/${code}`,
    lastModified: currentDate,
    changeFrequency: "daily" as const,
    priority: 0.8,
  }));

  // Add main shorts page
  const shortsRoutes = [
    {
      url: `${baseUrl}/shorts`,
      lastModified: currentDate,
      changeFrequency: "daily" as const,
      priority: 0.9,
    },
    {
      url: `${baseUrl}/stocks`,
      lastModified: currentDate,
      changeFrequency: "daily" as const,
      priority: 0.8,
    },
  ];

  // Documentation routes for LLMs and developers
  const docRoutes = [
    {
      url: `${baseUrl}/docs/llm-context`,
      lastModified: currentDate,
      changeFrequency: "weekly" as const,
      priority: 0.5,
    },
    {
      url: `${baseUrl}/docs/llm-context-raw`,
      lastModified: currentDate,
      changeFrequency: "weekly" as const,
      priority: 0.5,
    },
    {
      url: `${baseUrl}/docs/api-reference`,
      lastModified: currentDate,
      changeFrequency: "monthly" as const,
      priority: 0.6,
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
      changeFrequency: "daily" as const,
      priority: 0.7,
    },
    ...industrySlugs.map((slug) => ({
      url: `${baseUrl}/industry/${slug}`,
      lastModified: currentDate,
      changeFrequency: "daily" as const,
      priority: 0.7,
    })),
  ];

  // Glossary pages - index + individual terms
  const termSlugs = getAllTermSlugs();
  const glossaryRoutes = [
    {
      url: `${baseUrl}/glossary`,
      lastModified: currentDate,
      changeFrequency: "monthly" as const,
      priority: 0.6,
    },
    ...termSlugs.map((slug) => ({
      url: `${baseUrl}/glossary/${slug}`,
      lastModified: currentDate,
      changeFrequency: "monthly" as const,
      priority: 0.5,
    })),
  ];

  // Directory pages - index + per-letter
  const letters = "abcdefghijklmnopqrstuvwxyz".split("");
  const directoryRoutes = [
    {
      url: `${baseUrl}/directory`,
      lastModified: currentDate,
      changeFrequency: "weekly" as const,
      priority: 0.5,
    },
    ...letters.map((letter) => ({
      url: `${baseUrl}/directory/${letter}`,
      lastModified: currentDate,
      changeFrequency: "weekly" as const,
      priority: 0.4,
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
      changeFrequency: "daily" as const,
      priority: 0.8,
    },
    ...marketDates.map((date) => ({
      url: `${baseUrl}/market/${date}`,
      lastModified: currentDate,
      changeFrequency: "weekly" as const,
      priority: 0.6,
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

  const reportRoutes = [
    {
      url: `${baseUrl}/reports`,
      lastModified: currentDate,
      changeFrequency: "weekly" as const,
      priority: 0.7,
    },
    ...weekSlugs.map((slug) => ({
      url: `${baseUrl}/reports/weekly/${slug}`,
      lastModified: currentDate,
      changeFrequency: "weekly" as const,
      priority: 0.6,
    })),
    ...monthSlugs.map((slug) => ({
      url: `${baseUrl}/reports/monthly/${slug}`,
      lastModified: currentDate,
      changeFrequency: "monthly" as const,
      priority: 0.6,
    })),
    ...yearSlugs.map((slug) => ({
      url: `${baseUrl}/reports/yearly/${slug}`,
      lastModified: currentDate,
      changeFrequency: "yearly" as const,
      priority: 0.5,
    })),
  ];

  // FAQ page
  const faqRoutes = [
    {
      url: `${baseUrl}/faq`,
      lastModified: currentDate,
      changeFrequency: "monthly" as const,
      priority: 0.5,
    },
  ];

  // Privacy page
  const privacyRoutes = [
    {
      url: `${baseUrl}/privacy`,
      lastModified: currentDate,
      changeFrequency: "yearly" as const,
      priority: 0.2,
    },
  ];

  // Educational content hub
  const learnRoutes = [
    {
      url: `${baseUrl}/learn`,
      lastModified: currentDate,
      changeFrequency: "monthly" as const,
      priority: 0.7,
    },
    ...learnArticles.map((slug) => ({
      url: `${baseUrl}/learn/${slug}`,
      lastModified: currentDate,
      changeFrequency: "monthly" as const,
      priority: 0.6,
    })),
  ];

  // Top page (high priority landing page)
  const topRoutes = [
    {
      url: `${baseUrl}/top`,
      lastModified: currentDate,
      changeFrequency: "daily" as const,
      priority: 0.9,
    },
  ];

  // Screener page + preset URLs for SEO
  const screenerPresets = [
    "short-squeeze",
    "dividend-pressure",
    "small-cap-bears",
    "director-buying-shorted",
    "hard-to-cover",
  ];
  const screenerRoutes = [
    {
      url: `${baseUrl}/screener`,
      lastModified: currentDate,
      changeFrequency: "daily" as const,
      priority: 0.8,
    },
    ...screenerPresets.map((preset) => ({
      url: `${baseUrl}/screener?preset=${preset}`,
      lastModified: currentDate,
      changeFrequency: "weekly" as const,
      priority: 0.6,
    })),
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
