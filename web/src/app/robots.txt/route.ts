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

/**
 * Connect-RPC endpoints. Public, but they return protobuf-JSON — there is
 * nothing here a search engine can index, and every hit is pure crawl-budget
 * waste.
 *
 * These live at the ROOT (`/shorts.v1alpha1.StockService/GetStock`), not under
 * `/api/`, because `next.config.mjs` rewrites them straight through to
 * api.shorted.com.au for worker-cache hits. So the existing `Disallow: /api/`
 * never covered them, and Googlebot executes them while rendering.
 *
 * Measured on 2026-08-23, Googlebot on shorted.com.au over 24h:
 *   1,124 of 1,983 hits (56.7%) went to `/shorts.v1alpha1.*Service` paths.
 *   Actual content pages got ~19% (/shorts 198, /housing 89, /market 43,
 *   /reports 39, /compare 4) against a 8,748-URL sitemap.
 *
 * Blocking these is SAFE because every indexable surface is server-rendered —
 * verified against the raw HTML with no JS executed: /shorts/BHP carries the
 * company name and the live short percentage, /housing/<state>/<suburb> the
 * medians and prices, /economy/<state> the series values. The RPC calls
 * Googlebot makes are client-side hydration for charts, which are visual and
 * carry no indexable text.
 *
 * Do NOT add `/_next/` here — Google needs the JS and CSS to render the page,
 * and blocking it is a classic way to tank rendering.
 */
const RPC_PATHS = [
  "/shorts.v1alpha1.",
  "/marketdata.v1.",
  "/chat.v1.",
  "/register.v1.",
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
  // RPC paths are disallowed for AI crawlers too — the same reasoning applies:
  // the indexable content is in the HTML, and protobuf-JSON is not useful to
  // them either.
  const disallows = [...PRIVATE_PATHS, ...RPC_PATHS]
    .map((p) => `Disallow: ${p}`)
    .join("\n");

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
