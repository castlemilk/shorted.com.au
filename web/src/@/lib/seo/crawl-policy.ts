/**
 * The crawler lists robots.txt, the data-licence page and the Cloudflare
 * redirect share. They live here, not in app/robots.txt/route.ts, because a
 * Next.js route file may export only its handlers and route config: `next
 * build` rejects any other export ("does not match the required types of a
 * Next.js Route"), which Jest and tsc do not check.
 */

/**
 * Crawlers that get nothing here but the data-licence page. Each is either of
 * no use to an Australian finance audience, or was measured misbehaving
 * (Cloudflare zone analytics, 7 days to 2026-11-07):
 *   - Baiduspider: 109k requests, most of them a JS-rendering bot pulling
 *     suburb topojson and script chunks.
 *   - Reflectionbot: 59k, half of them redirect pairs; it fetched each housing
 *     state page about 1,100 times a day.
 *   - ShapBot: 40k, 2k of them on /signin and the session endpoint.
 *   - Bytespider, PetalBot, MJ12bot, SemrushBot, AhrefsBot, DotBot,
 *     DataForSeoBot: training or SEO scrapers that send no readers.
 * The Cloudflare redirect rule (`crawler_redirect_user_agents`) carries the
 * same list and steers them to /docs/data-licence at the edge, so one that
 * ignores robots.txt still never reaches the origin. A Terraform test holds
 * the two lists equal.
 */
export const STEERED_CRAWLERS = [
  "Baiduspider",
  "Bytespider",
  "PetalBot",
  "MJ12bot",
  "SemrushBot",
  "AhrefsBot",
  "DotBot",
  "DataForSeoBot",
  "Reflectionbot",
  "ShapBot",
];

/** Where a steered crawler is sent, and the one page it may read. */
export const DATA_LICENCE_PATH = "/docs/data-licence";
