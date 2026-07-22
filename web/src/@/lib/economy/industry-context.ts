import { createSlug } from "@/lib/industry-slug";

const INDUSTRY_SHORT_INTEREST_PREFIX = "markets.short_interest_avg.";
const INDUSTRY_SHORT_INTEREST_SUFFIX = ".aus";

// Source of truth: services/economy-collector/markets.go industrySlugs.
// Keep this pinned bridge in lockstep with the collector's emitted keys.
export const PINNED_INDUSTRY_SLUGS = new Set([
  "materials",
  "energy",
  "software-services",
  "financial-services",
  "health-care-equipment-services",
  "pharmaceuticals-biotechnology-life-sciences",
  "capital-goods",
  "commercial-professional-services",
  "media-entertainment",
  "food-beverage-tobacco",
  "consumer-discretionary-distribution-retail",
  "consumer-services",
  "equity-real-estate-investment-trusts-reits",
  "technology-hardware-equipment",
  "transportation",
  "real-estate-management-development",
  "utilities",
  "telecommunication-services",
  "consumer-durables-apparel",
  "banks",
  "household-personal-products",
  "insurance",
  "automobiles-components",
  "consumer-staples-distribution-retail",
  "semiconductors-semiconductor-equipment",
]);

/** Bridge a display industry name to the collector's derived series key. */
export function industryShortInterestSeriesKey(
  industryName: string,
): string | null {
  const slug = createSlug(industryName);
  return PINNED_INDUSTRY_SLUGS.has(slug)
    ? `${INDUSTRY_SHORT_INTEREST_PREFIX}${slug}${INDUSTRY_SHORT_INTEREST_SUFFIX}`
    : null;
}
