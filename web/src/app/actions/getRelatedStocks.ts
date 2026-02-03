"use server";

import { cache } from "react";
import { getStockDetails } from "./getStockDetails";
import { getIndustryStocks } from "./industry/getIndustryData";
import { type RelatedStock } from "~/@/components/seo/related-stocks";

// Create URL-friendly slug from industry name
function createSlug(industry: string): string {
  return industry
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Get related stocks in the same industry as the given stock.
 * Used for internal linking on stock detail pages.
 */
export const getRelatedStocks = cache(
  async (stockCode: string): Promise<{
    stocks: RelatedStock[];
    industry: string | null;
    industrySlug: string | null;
  }> => {
    try {
      // Get the stock's industry
      const stockDetails = await getStockDetails(stockCode);

      if (!stockDetails?.industry) {
        return { stocks: [], industry: null, industrySlug: null };
      }

      const industry = stockDetails.industry;
      const industrySlug = createSlug(industry);

      // Get other stocks in the same industry
      const { stocks } = await getIndustryStocks(industrySlug);

      // Map to RelatedStock format and filter out the current stock
      const relatedStocks: RelatedStock[] = stocks
        .filter((s) => s.code.toUpperCase() !== stockCode.toUpperCase())
        .slice(0, 6) // Limit to 6 related stocks
        .map((s) => ({
          code: s.code,
          name: s.name,
          shortPercent: s.shortPercent,
          industry,
        }));

      return {
        stocks: relatedStocks,
        industry,
        industrySlug,
      };
    } catch (error) {
      console.error("Failed to get related stocks:", error);
      return { stocks: [], industry: null, industrySlug: null };
    }
  }
);
