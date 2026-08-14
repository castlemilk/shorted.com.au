/**
 * Single source of truth for which /housing/[state]/[suburb] pages are
 * indexable by search engines, shared by the page's robots meta and the XML
 * sitemap. The suburb counterpart of {@link ./stock-indexability}.
 *
 * WHY THIS EXISTS
 *
 * The suburb route emitted no `robots` directive at all, so all 15,345 suburb
 * URLs were nominally indexable while the sitemap advertised only the ~3,600
 * with a Valuer-General median. That made the price filter a DISCOVERY gate
 * pretending to be an indexation gate — Google finds these pages by internal
 * links regardless.
 *
 * The real problem was never thinness. Measured against prod: priced coverage
 * is entirely NSW (53.5%), VIC (26.0%) and SA (25.1%). QLD, WA, ACT, TAS and NT
 * have ZERO priced suburbs between them, and still hold ~1,587 suburbs with a
 * population over 1,000. Those pages carry real content — Census demographics,
 * amenities, schools, council, federal and state representatives, and for NSW
 * crime — they simply have no price series, because no Valuer-General feed for
 * that state has been ingested yet.
 *
 * So an unpriced Queensland suburb was not thin. It was MISTITLED: every page
 * promised "House Prices" in its title and "Median house price" in its
 * description, including the thousands that have never had one. Fixing the
 * promise is what makes the page honest; the gate below decides which honest
 * pages are worth indexing.
 *
 * TWO GATES, ONE FLOOR
 *
 * As with stocks, the sitemap set is a strict SUBSET of the indexable set, so
 * the sitemap can never advertise a URL the page itself marks noindex — a
 * conflicting signal Google penalises.
 *
 *  - {@link isSuburbIndexable} — the page's `robots` metadata. Has the full
 *    profile, so it can see demographics and amenities.
 *  - {@link isSuburbSitemapEligible} — sitemap.ts, which knows only what
 *    ListStateSuburbs returns (name, price, population). It requires a price OR
 *    a population floor, both of which independently satisfy the page gate.
 */

/**
 * Population at or above which an unpriced suburb is still substantial enough
 * to index on its demographic and amenity content alone.
 *
 * 1,000 rather than 200: at 200 the corpus admits 6,965 suburbs, ~1,200 of them
 * with a population under 200 — localities where the Census itself suppresses
 * most cells, so the page would render mostly em-dashes. At 1,000 the addressable
 * set is 3,981, and the pages have enough non-price content to stand up.
 */
export const SUBURB_INDEX_MIN_POPULATION = 1000;

function hasText(value: string | undefined | null): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export interface SuburbIndexabilityInput {
  /** ABS SAL code — the stable identity of the suburb. */
  salCode?: string | null;
  /** Suburb name as published by the ABS. */
  salName?: string | null;
  /** Latest Valuer-General median, 0 when the state has no ingested feed. */
  latestMedianPrice?: number | null;
  /** Census usual-resident population. */
  population?: number | null;
  /** True when the profile carries amenity/school/council detail. */
  hasAmenities?: boolean | null;
}

/** A suburb must at least be identifiable before any other question matters. */
function isIdentifiable(input: { salCode?: string | null; salName?: string | null }): boolean {
  return hasText(input.salCode) && hasText(input.salName);
}

/**
 * Page-level gate. Index a suburb that is identifiable AND either has a real
 * price series, or is populous enough that its demographic content stands on
 * its own.
 *
 * Deliberately NOT gated on amenities: they are ingested per-state like prices,
 * so requiring them would re-create the same geography bias in a new coat.
 */
export function isSuburbIndexable(input: SuburbIndexabilityInput): boolean {
  if (!isIdentifiable(input)) return false;
  if ((input.latestMedianPrice ?? 0) > 0) return true;
  return (input.population ?? 0) >= SUBURB_INDEX_MIN_POPULATION;
}

export interface SuburbSitemapInput {
  salCode?: string | null;
  salName?: string | null;
  latestMedianPrice?: number | null;
  population?: number | null;
}

/**
 * Sitemap-level gate — a strict subset of {@link isSuburbIndexable}. Both of
 * its branches (price, population) are also branches of the page gate, so a
 * sitemap entry is always page-indexable.
 */
export function isSuburbSitemapEligible(input: SuburbSitemapInput): boolean {
  return isSuburbIndexable(input);
}

/**
 * Whether the page may describe itself in terms of price.
 *
 * This is the honesty half, and it is separate from indexability on purpose: a
 * populous unpriced suburb SHOULD be indexed, and its title should simply stop
 * claiming to be about house prices.
 */
export function suburbHasPrice(input: { latestMedianPrice?: number | null }): boolean {
  return (input.latestMedianPrice ?? 0) > 0;
}

/**
 * Title and description that match what the page can actually show.
 *
 * The priced variant keeps the existing wording, so ~3,600 already-indexed URLs
 * keep their titles and no established ranking is disturbed.
 */
export function suburbMetaCopy(input: {
  name: string;
  stateName: string;
  latestMedianPrice?: number | null;
}): { title: string; description: string } {
  if (suburbHasPrice(input)) {
    return {
      title: `${input.name} House Prices & Demographics`,
      description: `Median house price, ABS Census demographics and trends for ${input.name}, ${input.stateName}.`,
    };
  }
  return {
    title: `${input.name} Suburb Profile & Demographics`,
    description: `ABS Census demographics, amenities and local insights for ${input.name}, ${input.stateName}.`,
  };
}
