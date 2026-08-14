/**
 * Industry color mapping utility
 * Maps industry names to consistent Tailwind CSS badge color variants
 *
 * Palette rules (see DESIGN.md):
 * - Single warm hue family only. No blue/indigo/violet/purple/fuchsia.
 * - True red/green stay quarantined for market direction, so they never
 *   appear here.
 * - Every entry is hand-paired light/dark. Alpha tints (`/10`, `/20`) sit
 *   correctly on both warm paper and CRT black; only the text needs a
 *   `dark:` sibling.
 */

export type IndustryColorVariant =
  | "default"
  | "secondary"
  | "destructive"
  | "outline";

export type IndustryBadgeColor = {
  variant: IndustryColorVariant;
  className: string;
};

const AMBER =
  "bg-amber-500/10 text-amber-700 hover:bg-amber-500/20 dark:text-amber-300";
const ORANGE =
  "bg-orange-500/10 text-orange-700 hover:bg-orange-500/20 dark:text-orange-300";
const YELLOW =
  "bg-yellow-500/10 text-yellow-800 hover:bg-yellow-500/20 dark:text-yellow-300";
const OLIVE =
  "bg-lime-600/10 text-lime-800 hover:bg-lime-600/20 dark:text-lime-300";
const STONE =
  "bg-stone-500/10 text-stone-700 hover:bg-stone-500/20 dark:text-stone-300";
const NEUTRAL = "bg-muted text-muted-foreground hover:bg-muted/80";

/**
 * Get badge color configuration for an industry
 * @param industry - The industry name
 * @returns Badge color configuration with variant and additional className
 */
export function getIndustryColor(
  industry: string | undefined,
): IndustryBadgeColor {
  if (!industry) {
    return { variant: "secondary", className: NEUTRAL };
  }

  const normalizedIndustry = industry.toLowerCase();

  // Mining/Materials
  if (
    normalizedIndustry.includes("mining") ||
    normalizedIndustry.includes("materials") ||
    normalizedIndustry.includes("metal") ||
    normalizedIndustry.includes("gold") ||
    normalizedIndustry.includes("resources")
  ) {
    return { variant: "secondary", className: AMBER };
  }

  // Banks/Financials
  if (
    normalizedIndustry.includes("bank") ||
    normalizedIndustry.includes("financial") ||
    normalizedIndustry.includes("finance") ||
    normalizedIndustry.includes("investment") ||
    normalizedIndustry.includes("insurance")
  ) {
    return { variant: "secondary", className: STONE };
  }

  // Healthcare
  if (
    normalizedIndustry.includes("health") ||
    normalizedIndustry.includes("medical") ||
    normalizedIndustry.includes("pharmaceutical") ||
    normalizedIndustry.includes("biotech")
  ) {
    return { variant: "secondary", className: OLIVE };
  }

  // Technology
  if (
    normalizedIndustry.includes("technology") ||
    normalizedIndustry.includes("tech") ||
    normalizedIndustry.includes("software") ||
    normalizedIndustry.includes("it ") ||
    normalizedIndustry.includes("digital")
  ) {
    return { variant: "secondary", className: ORANGE };
  }

  // Retail
  if (
    normalizedIndustry.includes("retail") ||
    normalizedIndustry.includes("consumer") ||
    normalizedIndustry.includes("supermarket")
  ) {
    return { variant: "secondary", className: YELLOW };
  }

  // Energy
  if (
    normalizedIndustry.includes("energy") ||
    normalizedIndustry.includes("oil") ||
    normalizedIndustry.includes("gas") ||
    normalizedIndustry.includes("petroleum")
  ) {
    return { variant: "secondary", className: AMBER };
  }

  // Industrials
  if (
    normalizedIndustry.includes("industrial") ||
    normalizedIndustry.includes("manufacturing") ||
    normalizedIndustry.includes("construction") ||
    normalizedIndustry.includes("engineering")
  ) {
    return { variant: "secondary", className: STONE };
  }

  // Utilities
  if (
    normalizedIndustry.includes("utilities") ||
    normalizedIndustry.includes("utility") ||
    normalizedIndustry.includes("water") ||
    normalizedIndustry.includes("electricity")
  ) {
    return { variant: "secondary", className: OLIVE };
  }

  // Real Estate
  if (
    normalizedIndustry.includes("real estate") ||
    normalizedIndustry.includes("property") ||
    normalizedIndustry.includes("reit")
  ) {
    return { variant: "secondary", className: YELLOW };
  }

  // Telecommunications
  if (
    normalizedIndustry.includes("telecom") ||
    normalizedIndustry.includes("communication")
  ) {
    return { variant: "secondary", className: ORANGE };
  }

  return { variant: "secondary", className: NEUTRAL };
}
