import { buildHousingSitemap } from "~/@/lib/seo/sitemap-sections";
import { renderUrlset, sitemapResponse } from "~/@/lib/seo/sitemap-xml";

// See sitemap-core.xml/route.ts — force-dynamic is load-bearing here. This is
// the biggest child (~5.4k URLs, 8 parallel per-state RPCs); keeping it in its
// own document is why the ASX cluster no longer waits on housing.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  return sitemapResponse(renderUrlset(await buildHousingSitemap()));
}
