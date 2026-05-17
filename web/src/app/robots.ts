import { type MetadataRoute } from "next";
import { siteConfig } from "~/@/config/site";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          "/admin/",
          "/api/",
          "/embed/",
          "/subscribe/",
          "/alerts/",
          "/portfolio/",
          "/chat/",
          "/metrics/",
          "/dashboards/",
        ],
      },
      {
        // Allow AI crawlers to access content for AI search
        userAgent: [
          "GPTBot",
          "ChatGPT-User",
          "Google-Extended",
          "PerplexityBot",
          "ClaudeBot",
          "anthropic-ai",
          "CCBot",
        ],
        allow: [
          "/",
          "/shorts/",
          "/industry/",
          "/reports/",
          "/glossary/",
          "/learn/",
          "/blog/",
          "/docs/",
          "/news/",
          "/news",
          "/insider-trading/",
          "/insider-trading",
          "/data",
          "/search",
          "/llms.txt",
          "/llms-full.txt",
          "/ai.txt",
        ],
        disallow: [
          "/admin/",
          "/api/",
          "/embed/",
          "/subscribe/",
          "/alerts/",
          "/portfolio/",
          "/chat/",
          "/metrics/",
          "/dashboards/",
        ],
      },
    ],
    sitemap: `${siteConfig.url}/sitemap.xml`,
    host: siteConfig.url,
  };
}
