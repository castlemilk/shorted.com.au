/**
 * Single source of truth for which /shorts/[code] pages are indexable by search
 * engines, shared by the page's robots meta and the XML sitemap.
 *
 * Why this exists: every stock page is server-rendered with a unique,
 * substantial narrative (ASIC short data + company profile + financials), so
 * pages for real companies deserve to be indexed. The previous policy
 * noindex'd any stock under 0.5% short interest, which excluded ~87% of
 * stocks — including major companies like Brambles (BXB) and Downer (DOW) —
 * and was the dominant cause of "Excluded by noindex" in Search Console.
 *
 * We now index any *named* company that is either enriched (has an industry
 * classification — a strong proxy for "real, live company with content") OR
 * meaningfully shorted. Only genuinely thin stubs (no name, no industry, and
 * negligible short interest — typically delisted instruments) stay out of the
 * index.
 *
 * Two gates share ONE floor so the sitemap can never advertise a URL the page
 * itself marks noindex (a conflicting signal Google penalises):
 *
 *  - {@link isStockIndexable} — used by the page's `robots` metadata. Has the
 *    full Stock object (name + industry + short %).
 *
 *  - {@link isStockSitemapEligible} — used by sitemap.ts, which only knows the
 *    code, name and latest short %. Because it requires short % >= the same
 *    floor, every sitemap entry also satisfies the page gate via the
 *    short-interest branch, making the sitemap set a strict SUBSET of the
 *    indexable set. The two can therefore never disagree.
 */

/** ASX product codes the /shorts/[code] route accepts (1-4 alphanumerics). */
export const VALID_STOCK_CODE = /^[A-Z0-9]{1,4}$/;

/**
 * Short-interest floor (percent of issued capital) at/above which a stock is
 * indexed and sitemap-listed regardless of enrichment. Below it, a stock is
 * only indexed when it carries richer metadata (an industry classification).
 */
export const STOCK_INDEX_MIN_SHORT_PCT = 0.1;

function hasValidCode(code: string | undefined | null): boolean {
  return typeof code === "string" && VALID_STOCK_CODE.test(code);
}

function hasText(value: string | undefined | null): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export interface StockIndexabilityInput {
  /** ASX product code, e.g. "BHP". */
  code: string;
  /** Company / product name. */
  name?: string | null;
  /** Industry classification (presence implies an enriched, real company). */
  industry?: string | null;
  /** Latest reported short interest as a percent of issued capital. */
  percentShorted?: number | null;
}

/**
 * Page-level gate. Index a stock when it has a valid code, a company name, and
 * either an industry classification (enriched / real company) or a short
 * position at or above {@link STOCK_INDEX_MIN_SHORT_PCT}.
 */
export function isStockIndexable(input: StockIndexabilityInput): boolean {
  if (!hasValidCode(input.code)) return false;
  if (!hasText(input.name)) return false;
  return (
    hasText(input.industry) ||
    (input.percentShorted ?? 0) >= STOCK_INDEX_MIN_SHORT_PCT
  );
}

export interface StockSitemapInput {
  code: string;
  name?: string | null;
  percentShorted?: number | null;
}

/**
 * Sitemap-level gate. A strict subset of {@link isStockIndexable}: any stock
 * that passes this (short % >= floor) is also page-indexable via the
 * short-interest branch, so the sitemap never lists a noindexed URL.
 */
export function isStockSitemapEligible(input: StockSitemapInput): boolean {
  if (!hasValidCode(input.code)) return false;
  if (!hasText(input.name)) return false;
  return (input.percentShorted ?? 0) >= STOCK_INDEX_MIN_SHORT_PCT;
}
