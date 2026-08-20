import { siteConfig } from "~/@/config/site";
import {
  SITEMAP_CHILDREN,
  renderSitemapIndex,
  sitemapResponse,
} from "~/@/lib/seo/sitemap-xml";

/**
 * /sitemap.xml — the sitemapINDEX.
 *
 * Replaces the old app/sitemap.ts flat urlset (8,686 URLs, ~6.9s to generate,
 * 62% of it housing). The index itself fetches nothing, so it is force-static
 * and answers instantly; the five children each carry their own section and
 * their own recrawl signal. See ~/@/lib/seo/sitemap-xml.ts for the full URL map.
 *
 * Written as an explicit route handler (like robots.txt) rather than Next's
 * generateSitemaps convention: the child URLs are then plain, stable,
 * human-readable paths we control, instead of /sitemap/<id>.xml whose shape
 * differs between `next dev` and production.
 *
 * NO <lastmod> on the children: it would have to be a render-time constant,
 * which is exactly the fake signal this restructure removed.
 */
export const dynamic = "force-static";

export function GET() {
  return sitemapResponse(
    renderSitemapIndex(
      SITEMAP_CHILDREN.map((child) => ({ url: `${siteConfig.url}/${child}` })),
    ),
  );
}
