import { type MetadataRoute } from "next";
import { siteConfig } from "~/@/config/site";
import { getAllPosts } from "~/@/lib/api";
import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";

/**
 * Fetch all stock codes from the API for the sitemap.
 * Uses getTopShorts with a high limit to get all stocks with short positions.
 */
async function getAllStockCodes(): Promise<string[]> {
  try {
    const transport = createConnectTransport({
      baseUrl:
        process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT ??
        process.env.NEXT_PUBLIC_API_URL ??
        "http://localhost:9091",
    });

    const client = createClient(ShortedStocksService, transport);

    // Fetch top shorts with a high limit to get all stocks
    // The API returns stocks sorted by short position, so this gets all actively shorted stocks
    const response = await client.getTopShorts({
      period: "max",
      limit: 1000, // Get up to 1000 stocks for sitemap
      offset: 0,
    });

    // Extract unique stock codes from the response
    const stockCodes = response.timeSeries
      .map((ts) => ts.productCode)
      .filter((code): code is string => !!code);

    return [...new Set(stockCodes)]; // Deduplicate
  } catch (error) {
    console.error("Failed to fetch stock codes for sitemap:", error);
    // Fallback to popular stocks if API fails
    return [
      "CBA",
      "BHP",
      "CSL",
      "NAB",
      "WBC",
      "ANZ",
      "WES",
      "MQG",
      "WOW",
      "TLS",
      "RIO",
      "FMG",
      "GMG",
      "TCL",
      "WDS",
      "NCM",
      "ALL",
      "COL",
      "REA",
      "QBE",
    ];
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

  return [
    ...staticRoutes,
    ...shortsRoutes,
    ...docRoutes,
    ...blogRoutes,
    ...stockRoutes,
  ];
}
