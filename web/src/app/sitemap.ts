import { type MetadataRoute } from "next";
import { siteConfig } from "~/@/config/site";
import { getAllPosts } from "~/@/lib/api";

export default function sitemap(): MetadataRoute.Sitemap {
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

  // Popular ASX stock pages (top 50 by market cap and activity)
  // TODO: In production, fetch all stock codes from the database
  const popularStocks = [
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
    "APT",
    "XRO",
    "SHL",
    "RMD",
    "COH",
    "IAG",
    "SUN",
    "ORG",
    "APA",
    "TWE",
    "CPU",
    "MPL",
    "AGL",
    "ASX",
    "STO",
    "S32",
    "A2M",
    "JHX",
    "SGP",
    "GPT",
    "MIN",
    "EVN",
    "NST",
    "OZL",
    "WHC",
    "PLS",
    "LYC",
    "IGO",
    "NHC",
    "WTC",
  ];

  const stockRoutes = popularStocks.map((code) => ({
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
