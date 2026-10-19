"use server";

import { cache } from "react";
import { getStockDetails } from "./getStockDetails";
import { getVerifiedCompanyLogoUrls } from "./company-logo-availability";
import { getIndustryStocks } from "./industry/getIndustryData";
import { type RelatedStock } from "~/@/components/seo/related-stocks";
import { industryLabel } from "~/@/lib/industry-placeholder";
import { createSlug } from "~/@/lib/industry-slug";

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
      // Get the stock's industry. The ASX's "Not Applic" of an ETF or a trust
      // is none: related "by industry" would mean nothing, and its slug would
      // send the Company tab's evidence panel to an industry that is not there.
      const stockDetails = await getStockDetails(stockCode);
      const industry = industryLabel(stockDetails?.industry);

      if (!industry) {
        return { stocks: [], industry: null, industrySlug: null };
      }

      const industrySlug = createSlug(industry);

      // Get other stocks in the same industry
      const { stocks } = await getIndustryStocks(industrySlug);

      // Filter out the current stock
      const others = stocks
        .filter((s) => s.code.toUpperCase() !== stockCode.toUpperCase())
        .slice(0, 6); // Limit to 6 related stocks

      // A logo only for a code the bucket holds: one cached listing, never a
      // read per stock, and never a rejection (an empty map on failure). The
      // rest draw StockLogo's letter avatar instead of requesting a 404.
      const logoUrls = await getVerifiedCompanyLogoUrls(others.map((s) => s.code));

      // Map to RelatedStock format
      const relatedStocks: RelatedStock[] = others.map((s) => ({
        code: s.code,
        name: s.name,
        shortPercent: s.shortPercent,
        industry,
        logoUrl: logoUrls.get(s.code.toUpperCase()),
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
