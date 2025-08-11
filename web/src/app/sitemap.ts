import { type MetadataRoute } from "next";
import { siteConfig } from "~/@/config/site";
import { getAllPosts } from "@/lib/api";

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

  // TODO: Add dynamic routes for stock pages
  // This would require fetching all stock codes from your API
  // const stockCodes = await getAllStockCodes()
  // const stockRoutes = stockCodes.map((code) => ({
  //   url: `${baseUrl}/shorts/${code}`,
  //   lastModified: currentDate,
  //   changeFrequency: 'daily' as const,
  //   priority: 0.8,
  // }))

  return [...staticRoutes, ...blogRoutes];
}
