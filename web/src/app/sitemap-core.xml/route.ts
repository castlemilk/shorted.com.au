import { buildCoreSitemap } from "~/@/lib/seo/sitemap-sections";
import { renderUrlset, sitemapResponse } from "~/@/lib/seo/sitemap-xml";

// Render at request time, never from build output — the build runs with
// SKIP_STATIC_GENERATION=1 and would bake a degenerate fallback that ISR then
// serves for an hour after every deploy (GSC regression, July 2026).
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  return sitemapResponse(renderUrlset(await buildCoreSitemap()));
}
