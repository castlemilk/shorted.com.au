import { buildShortsSitemap } from "~/@/lib/seo/sitemap-sections";
import { renderUrlset, sitemapResponse } from "~/@/lib/seo/sitemap-xml";

// See sitemap-core.xml/route.ts — force-dynamic is load-bearing here.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  return sitemapResponse(renderUrlset(await buildShortsSitemap()));
}
