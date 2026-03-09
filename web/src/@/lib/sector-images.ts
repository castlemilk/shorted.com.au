/**
 * Maps industry names to sector image paths.
 * Images are 256x256 gold medallion-style icons stored in /assets/sectors/.
 *
 * IMPORTANT: This is an explicit map from every known GICS industry name
 * (as returned by the production API) to the image filename. If a new industry
 * appears, add it here — there is no fuzzy matching.
 */

// Explicit map: lowercase industry name → image filename (without extension).
// Every production GICS name must have an entry here.
const INDUSTRY_TO_IMAGE: Record<string, string> = {
  // ─── Exact GICS names from production API ─────────────────────────────
  "automobiles & components":                         "automobiles",
  "banks":                                            "banks",
  "capital goods":                                    "materials",
  "commercial & professional services":               "professional_services",
  "consumer discretionary distribution & retail":     "retail",
  "consumer durables & apparel":                      "consumer_durables",
  "consumer services":                                "consumer_services",
  "consumer staples distribution & retail":           "consumer_staples",
  "energy":                                           "energy",
  "equity real estate investment trusts (reits)":     "reits",
  "financial services":                               "financial_services",
  "food, beverage & tobacco":                         "food_beverage",
  "health care equipment & services":                 "health_care",
  "household & personal products":                    "household_products",
  "insurance":                                        "insurance",
  "materials":                                        "materials",
  "media & entertainment":                            "media_entertainment",
  "other":                                            "other",
  "pharmaceuticals, biotechnology & life sciences":   "pharmaceuticals_biotech",
  "real estate management & development":             "real_estate",
  "semiconductors & semiconductor equipment":         "semiconductors",
  "software & services":                              "software_services",
  "technology hardware & equipment":                  "technology_hardware",
  "telecommunication services":                       "telecommunications",
  "transportation":                                   "transportation",
  "utilities":                                        "utilities",

  // ─── Invalid ASIC classifications → "other" ───────────────────────────
  "class pend":     "other",
  "not applic":     "other",
  "not applicable": "other",
  "":               "other",
};

/**
 * Resolve an industry name to its image filename.
 * Falls back to "other" if no match found.
 */
function industryToFilename(industry: string): string {
  return INDUSTRY_TO_IMAGE[industry.toLowerCase().trim()] ?? "other";
}

/**
 * Get the WebP image path for an industry name.
 * Use with next/image for automatic avif/webp optimization.
 */
export function getSectorImagePath(industry: string): string {
  return `/assets/sectors/${industryToFilename(industry)}.webp`;
}

/**
 * Get the PNG image path (for OG images where base64 encoding is needed).
 */
export function getSectorImagePathPng(industry: string): string {
  return `/assets/sectors/${industryToFilename(industry)}.png`;
}

/**
 * Get alt text for a sector image.
 */
export function getSectorImageAlt(industry: string): string {
  return `${industry} sector icon`;
}

/**
 * Get the list of all known valid GICS industry names (for filter dropdowns etc).
 * Excludes invalid ASIC classifications.
 */
export function getKnownIndustries(): string[] {
  const EXCLUDE = new Set(["class pend", "not applic", "not applicable", "", "other"]);
  return Object.keys(INDUSTRY_TO_IMAGE)
    .filter((k) => !EXCLUDE.has(k))
    .map((k) =>
      k.replace(/\b\w/g, (c) => c.toUpperCase()) // Title Case
    )
    .sort();
}
