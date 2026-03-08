/**
 * Maps industry names to sector image paths.
 * Images are 256x256 gold medallion-style icons stored as WebP in /assets/sectors/.
 * Use with next/image for automatic optimization (avif/webp, responsive sizing).
 */

// All available sector image filenames (without extension)
const SECTOR_IMAGE_FILES = new Set([
  "automobiles",
  "banks",
  "consumer_durables",
  "consumer_goods",
  "consumer_services",
  "consumer_staples",
  "energy",
  "financial_services",
  "food_beverage",
  "health_care",
  "household_products",
  "insurance",
  "materials",
  "media_entertainment",
  "other",
  "pharmaceuticals_biotech",
  "professional_services",
  "real_estate",
  "reits",
  "retail",
  "semiconductors",
  "software_services",
  "technology_hardware",
  "telecommunications",
  "transportation",
  "utilities",
]);

// Manual overrides for GICS industry names that don't map cleanly to image filenames.
// These are the actual industry names returned by the enrichment processor / company-metadata table.
const INDUSTRY_NAME_OVERRIDES: Record<string, string> = {
  // Exact GICS names from production API
  "health care equipment & services": "health_care",
  "pharmaceuticals, biotechnology & life sciences": "pharmaceuticals_biotech",
  "equity real estate investment trusts (reits)": "reits",
  "consumer discretionary distribution & retail": "retail",
  "consumer staples distribution & retail": "consumer_staples",
  "real estate management & development": "real_estate",
  "telecommunication services": "telecommunications",
  "automobiles & components": "automobiles",
  "semiconductors & semiconductor equipment": "semiconductors",
  "commercial & professional services": "professional_services",
  "media & entertainment": "media_entertainment",
  "food, beverage & tobacco": "food_beverage",
  "technology hardware & equipment": "technology_hardware",
  "software & services": "software_services",
  "consumer durables & apparel": "consumer_durables",
  "household & personal products": "household_products",
  "capital goods": "materials",

  // Alternate forms (with "and" instead of "&")
  "health care equipment and services": "health_care",
  "pharmaceuticals, biotechnology and life sciences": "pharmaceuticals_biotech",
  "consumer discretionary distribution and retail": "retail",
  "consumer staples distribution and retail": "consumer_staples",
  "real estate management and development": "real_estate",
  "automobiles and components": "automobiles",
  "semiconductors and semiconductor equipment": "semiconductors",
  "commercial and professional services": "professional_services",
  "media and entertainment": "media_entertainment",
  "food, beverage and tobacco": "food_beverage",
  "technology hardware and equipment": "technology_hardware",
  "software and services": "software_services",
  "consumer durables and apparel": "consumer_durables",
  "household and personal products": "household_products",

  // Short forms and aliases
  "real estate investment trusts": "reits",
  "reits": "reits",
  "food & beverage": "food_beverage",
  "food and beverage": "food_beverage",
  "pharmaceuticals & biotechnology": "pharmaceuticals_biotech",
  "pharmaceuticals & biotech": "pharmaceuticals_biotech",
  "pharma & biotech": "pharmaceuticals_biotech",
  "biotech": "pharmaceuticals_biotech",
  "biotechnology": "pharmaceuticals_biotech",
  "it services": "software_services",
  "tech hardware": "technology_hardware",
  "diversified financials": "financial_services",

  // Invalid ASIC classifications
  "class pend": "other",
  "not applic": "other",
  "not applicable": "other",
};

/**
 * Convert an industry name to the corresponding sector image filename.
 * Returns null if no matching image exists.
 */
function industryToFilename(industry: string): string | null {
  const lower = industry.toLowerCase().trim();

  // Check manual overrides first
  const override = INDUSTRY_NAME_OVERRIDES[lower];
  if (override) {
    return override;
  }

  // Convert to snake_case and check
  const snakeCase = lower
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

  if (SECTOR_IMAGE_FILES.has(snakeCase)) {
    return snakeCase;
  }

  // Try without common suffixes
  for (const suffix of ["_and_apparel", "_and_equipment", "_and_tobacco"]) {
    const trimmed = snakeCase.replace(suffix, "");
    if (SECTOR_IMAGE_FILES.has(trimmed)) {
      return trimmed;
    }
  }

  return null;
}

/**
 * Get the WebP image path for an industry name.
 * Returns the fallback "other" image if no match found.
 */
export function getSectorImagePath(industry: string): string {
  const filename = industryToFilename(industry) ?? "other";
  return `/assets/sectors/${filename}.webp`;
}

/**
 * Get the PNG image path for an industry name (for OG images / fallback).
 */
export function getSectorImagePathPng(industry: string): string {
  const filename = industryToFilename(industry) ?? "other";
  return `/assets/sectors/${filename}.png`;
}

/**
 * Get alt text for a sector image.
 */
export function getSectorImageAlt(industry: string): string {
  return `${industry} sector icon`;
}
