import { type MetadataRoute } from "next";
import { siteConfig } from "~/@/config/site"
import { getAllPosts } from "~/@/lib/api";

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

// Production API URL for sitemap generation during builds
const PRODUCTION_API_URL = "https://api.shorted.com.au";

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
      PRODUCTION_API_URL;

    // Use direct fetch with JSON to avoid protobuf-es SSR issues
    const response = await fetch(
      `${baseUrl}/shorts.v1alpha1.ShortedStocksService/GetTopShorts`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          period: "max",
          limit: 1000,
          offset: 0,
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
  const staticRoutes = [
    {
      url: baseUrl,
      lastModified: currentDate,
      changeFrequency: "daily" as const,
      priority: 1,
    },
    {
      url: `${baseUrl}/about`,
      lastModified: currentDate,
      changeFrequency: "monthly" as const,
      priority: 0.8,
    },
    {
      url: `${baseUrl}/blog`,
      lastModified: currentDate,
      changeFrequency: "weekly" as const,
      priority: 0.7,
    },
    {
      url: `${baseUrl}/dashboards`,
      lastModified: currentDate,
      changeFrequency: "daily" as const,
      priority: 0.9,
    },
    {
      url: `${baseUrl}/terms`,
      lastModified: currentDate,
      changeFrequency: "yearly" as const,
      priority: 0.3,
    },
    {
      url: `${baseUrl}/roadmap`,
      lastModified: currentDate,
      changeFrequency: "monthly" as const,
      priority: 0.6,
    },
  ];

  // Blog post routes
  const posts = getAllPosts();
  const blogRoutes = posts.map((post) => ({
    url: `${baseUrl}/blog/${post.slug}`,
    lastModified: post.date,
    changeFrequency: "monthly" as const,
    priority: 0.7,
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
      changeFrequency: "hourly" as const,
      priority: 0.9,
    },
    {
      url: `${baseUrl}/stocks`,
      lastModified: currentDate,
      changeFrequency: "daily" as const,
      priority: 0.9,
    },
    {
      url: `${baseUrl}/portfolio`,
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
      priority: 0.7,
    },
    {
      url: `${baseUrl}/docs/llm-context-raw`,
      lastModified: currentDate,
      changeFrequency: "weekly" as const,
      priority: 0.6,
    },
    {
      url: `${baseUrl}/docs/api-reference`,
      lastModified: currentDate,
      changeFrequency: "weekly" as const,
      priority: 0.7,
    },
  ];

  // New SEO routes - Industry pages
  const industryRoutes = [
    {
      url: `${baseUrl}/industry`,
      lastModified: currentDate,
      changeFrequency: "daily" as const,
      priority: 0.9,
    },
  ];

  // Glossary page
  const glossaryRoutes = [
    {
      url: `${baseUrl}/glossary`,
      lastModified: currentDate,
      changeFrequency: "monthly" as const,
      priority: 0.7,
    },
  ];

  // FAQ page
  const faqRoutes = [
    {
      url: `${baseUrl}/faq`,
      lastModified: currentDate,
      changeFrequency: "monthly" as const,
      priority: 0.8,
    },
  ];

  // Privacy page
  const privacyRoutes = [
    {
      url: `${baseUrl}/privacy`,
      lastModified: currentDate,
      changeFrequency: "yearly" as const,
      priority: 0.4,
    },
  ];

  // Educational content hub
  const learnRoutes = [
    {
      url: `${baseUrl}/learn`,
      lastModified: currentDate,
      changeFrequency: "weekly" as const,
      priority: 0.8,
    },
    ...learnArticles.map((slug) => ({
      url: `${baseUrl}/learn/${slug}`,
      lastModified: currentDate,
      changeFrequency: "monthly" as const,
      priority: 0.7,
    })),
  ];

  // RSS feed
  const feedRoutes = [
    {
      url: `${baseUrl}/feed.xml`,
      lastModified: currentDate,
      changeFrequency: "daily" as const,
      priority: 0.5,
    },
  ];

  // Top page (high priority landing page)
  const topRoutes = [
    {
      url: `${baseUrl}/top`,
      lastModified: currentDate,
      changeFrequency: "daily" as const,
      priority: 0.95,
    },
  ];

  return [
    ...staticRoutes,
    ...topRoutes,
    ...shortsRoutes,
    ...industryRoutes,
    ...glossaryRoutes,
    ...faqRoutes,
    ...privacyRoutes,
    ...learnRoutes,
    ...docRoutes,
    ...feedRoutes,
    ...blogRoutes,
    ...stockRoutes,
  ];
}
