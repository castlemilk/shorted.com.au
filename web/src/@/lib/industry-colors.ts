/**
 * Industry color mapping utility
 * Maps industry names to consistent Tailwind CSS badge color variants
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

/**
 * Get badge color configuration for an industry
 * @param industry - The industry name
 * @returns Badge color configuration with variant and additional className
 */
export function getIndustryColor(
  industry: string | undefined,
): IndustryBadgeColor {
  if (!industry) {
    return {
      variant: "secondary",
      className: "bg-slate-100 text-slate-700 hover:bg-slate-200",
    };
  }

  const normalizedIndustry = industry.toLowerCase();

  // Mining/Materials - amber
  if (
    normalizedIndustry.includes("mining") ||
    normalizedIndustry.includes("materials") ||
    normalizedIndustry.includes("metal") ||
    normalizedIndustry.includes("gold") ||
    normalizedIndustry.includes("resources")
  ) {
    return {
      variant: "secondary",
      className: "bg-amber-100 text-amber-700 hover:bg-amber-200",
    };
  }

  // Banks/Financials - blue
  if (
    normalizedIndustry.includes("bank") ||
    normalizedIndustry.includes("financial") ||
    normalizedIndustry.includes("finance") ||
    normalizedIndustry.includes("investment") ||
    normalizedIndustry.includes("insurance")
  ) {
    return {
      variant: "secondary",
      className: "bg-blue-100 text-blue-700 hover:bg-blue-200",
    };
  }

  // Healthcare - green
  if (
    normalizedIndustry.includes("health") ||
    normalizedIndustry.includes("medical") ||
    normalizedIndustry.includes("pharmaceutical") ||
    normalizedIndustry.includes("biotech")
  ) {
    return {
      variant: "secondary",
      className: "bg-green-100 text-green-700 hover:bg-green-200",
    };
  }

  // Technology - purple
  if (
    normalizedIndustry.includes("technology") ||
    normalizedIndustry.includes("tech") ||
    normalizedIndustry.includes("software") ||
    normalizedIndustry.includes("it ") ||
    normalizedIndustry.includes("digital")
  ) {
    return {
      variant: "secondary",
      className: "bg-purple-100 text-purple-700 hover:bg-purple-200",
    };
  }

  // Retail - pink
  if (
    normalizedIndustry.includes("retail") ||
    normalizedIndustry.includes("consumer") ||
    normalizedIndustry.includes("supermarket")
  ) {
    return {
      variant: "secondary",
      className: "bg-pink-100 text-pink-700 hover:bg-pink-200",
    };
  }

  // Energy - orange
  if (
    normalizedIndustry.includes("energy") ||
    normalizedIndustry.includes("oil") ||
    normalizedIndustry.includes("gas") ||
    normalizedIndustry.includes("petroleum")
  ) {
    return {
      variant: "secondary",
      className: "bg-orange-100 text-orange-700 hover:bg-orange-200",
    };
  }

  // Industrials - gray
  if (
    normalizedIndustry.includes("industrial") ||
    normalizedIndustry.includes("manufacturing") ||
    normalizedIndustry.includes("construction") ||
    normalizedIndustry.includes("engineering")
  ) {
    return {
      variant: "secondary",
      className: "bg-gray-100 text-gray-700 hover:bg-gray-200",
    };
  }

  // Utilities - cyan
  if (
    normalizedIndustry.includes("utilities") ||
    normalizedIndustry.includes("utility") ||
    normalizedIndustry.includes("water") ||
    normalizedIndustry.includes("electricity")
  ) {
    return {
      variant: "secondary",
      className: "bg-cyan-100 text-cyan-700 hover:bg-cyan-200",
    };
  }

  // Real Estate - emerald
  if (
    normalizedIndustry.includes("real estate") ||
    normalizedIndustry.includes("property") ||
    normalizedIndustry.includes("reit")
  ) {
    return {
      variant: "secondary",
      className: "bg-emerald-100 text-emerald-700 hover:bg-emerald-200",
    };
  }

  // Telecommunications - indigo
  if (
    normalizedIndustry.includes("telecom") ||
    normalizedIndustry.includes("communication")
  ) {
    return {
      variant: "secondary",
      className: "bg-indigo-100 text-indigo-700 hover:bg-indigo-200",
    };
  }

  // Default - slate
  return {
    variant: "secondary",
    className: "bg-slate-100 text-slate-700 hover:bg-slate-200",
  };
}
