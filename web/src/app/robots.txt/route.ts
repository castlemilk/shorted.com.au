import { siteConfig } from "~/@/config/site";
import { SITEMAP_CHILDREN } from "~/@/lib/seo/sitemap-xml";

export const dynamic = "force-static";

// Explicit route handler instead of the typed app/robots.ts metadata route:
// MetadataRoute.Robots cannot express Content-Signal directives
// (https://contentsignals.org/), which agent-readiness scanners check for.
// This replaces both the old app/robots.ts and the stale public/robots.txt.

const PRIVATE_PATHS = [
  "/admin/",
  "/api/",
  "/embed/",
  "/subscribe/",
  "/alerts/",
  "/portfolio/",
  "/chat/",
  "/metrics/",
  "/dashboards/",
];

const AI_CRAWLERS = [
  "GPTBot",
  "ChatGPT-User",
  "Google-Extended",
  "PerplexityBot",
  "ClaudeBot",
  "anthropic-ai",
  "CCBot",
];

const AI_ALLOWED_PATHS = [
  "/",
  "/shorts/",
  "/top",
  "/battlegrounds",
  "/statistics",
  "/scans",
  "/scans/",
  "/industry/",
  "/reports/",
  "/market/",
  "/market",
  "/screener",
  "/seasonality",
  "/compare/",
  "/directory/",
  "/directory",
  "/housing/",
  "/housing",
  "/features/",
  "/glossary/",
  "/learn/",
  "/faq",
  "/blog/",
  "/docs/",
  "/news/",
  "/news",
  "/insider-trading/",
  "/insider-trading",
  "/data",
  "/search",
  "/authors/",
  "/authors",
  "/llms.txt",
  "/llms-full.txt",
  "/ai.txt",
];

export function GET() {
  const disallows = PRIVATE_PATHS.map((p) => `Disallow: ${p}`).join("\n");

  const body = `# robots.txt for ${siteConfig.url}
# Official ASIC short position data for ASX stocks — we WANT this content
# discoverable and usable by search engines and AI systems (see /ai.txt).

User-Agent: *
Allow: /
${disallows}

# Content Signals (https://contentsignals.org/) — consistent with /ai.txt
Content-Signal: search=yes, ai-input=yes, ai-train=yes

# AI crawlers — explicitly welcome
${AI_CRAWLERS.map((ua) => `User-Agent: ${ua}`).join("\n")}
${AI_ALLOWED_PATHS.map((p) => `Allow: ${p}`).join("\n")}
${disallows}

Host: ${siteConfig.url}
# /sitemap.xml is a sitemapindex; the children are listed too so a crawler that
# does not follow index files still finds every section.
Sitemap: ${siteConfig.url}/sitemap.xml
${SITEMAP_CHILDREN.map((child) => `Sitemap: ${siteConfig.url}/${child}`).join("\n")}
`;

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
