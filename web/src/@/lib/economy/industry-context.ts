import { createSlug } from "@/lib/industry-slug";

const INDUSTRY_SHORT_INTEREST_PREFIX = "markets.short_interest_avg.";
const INDUSTRY_SHORT_INTEREST_SUFFIX = ".aus";

/** Bridge a display industry name to the collector's derived series key. */
export function industryShortInterestSeriesKey(industryName: string): string {
  return `${INDUSTRY_SHORT_INTEREST_PREFIX}${createSlug(industryName)}${INDUSTRY_SHORT_INTEREST_SUFFIX}`;
}

/** Recover the canonical industry slug from a derived short-interest key. */
export function industrySlugFromShortInterestSeriesKey(
  seriesKey: string,
): string | null {
  if (
    !seriesKey.startsWith(INDUSTRY_SHORT_INTEREST_PREFIX) ||
    !seriesKey.endsWith(INDUSTRY_SHORT_INTEREST_SUFFIX)
  ) {
    return null;
  }
  const slug = seriesKey.slice(
    INDUSTRY_SHORT_INTEREST_PREFIX.length,
    -INDUSTRY_SHORT_INTEREST_SUFFIX.length,
  );
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ? slug : null;
}
