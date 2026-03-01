"use server";

import { SHORTS_API_URL } from "../config";
import { cache } from "react";
import { getOrSetCached, CACHE_KEYS } from "~/@/lib/kv-cache";

// ViewMode enum values - using constants to avoid protobuf-es SSR issues
const VIEW_MODE_CURRENT_CHANGE = 0;

// API response types for industry treemap
interface TreeMapStock {
  productCode?: string;
  industry?: string;
  shortPosition?: number;
}

interface TreeMapResponse {
  stocks: TreeMapStock[];
}

export interface IndustryStats {
  name: string;
  slug: string;
  stockCount: number;
  avgShortPercent: number;
  totalShortPercent: number;
  topStock: {
    code: string;
    name: string;
    shortPercent: number;
  } | null;
}

// Raw ASIC classifications that should be mapped to "Other"
const INVALID_INDUSTRIES = new Set([
  "Class Pend",
  "Not Applic",
  "Not Applicable",
  "",
]);

// Create URL-friendly slug from industry name
function createSlug(industry: string): string {
  return industry
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// Get aggregated industry statistics using IndustryTreeMap endpoint
export const getIndustryData = cache(async (): Promise<IndustryStats[]> => {
  const cacheKey = `${CACHE_KEYS.industryTreeMap("max", 50, "current")}:industries-index`;

  return getOrSetCached(
    cacheKey,
    async () => {
      const baseUrl = process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT ?? SHORTS_API_URL;

      // Use direct fetch to avoid protobuf-es SSR issues
      const fetchResponse = await fetch(
        `${baseUrl}/shorts.v1alpha1.ShortedStocksService/GetIndustryTreeMap`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            period: "max",
            limit: 50,
            viewMode: VIEW_MODE_CURRENT_CHANGE,
          }),
        }
      );

      if (!fetchResponse.ok) {
        throw new Error(`API returned ${fetchResponse.status}`);
      }

      const response = (await fetchResponse.json()) as TreeMapResponse;

      // Group stocks by industry
      const industryMap = new Map<
        string,
        {
          stocks: Array<{
            code: string;
            shortPercent: number;
          }>;
          totalPercent: number;
        }
      >();

      for (const stock of response.stocks) {
        let industry = stock.industry?.trim() ?? "Other";
        if (INVALID_INDUSTRIES.has(industry)) {
          industry = "Other";
        }
        const shortPercent = stock.shortPosition ?? 0;

        if (!industryMap.has(industry)) {
          industryMap.set(industry, { stocks: [], totalPercent: 0 });
        }

        const data = industryMap.get(industry)!;
        data.stocks.push({
          code: stock.productCode ?? "",
          shortPercent,
        });
        data.totalPercent += shortPercent;
      }

      // Calculate stats and sort by average short percent
      const industries: IndustryStats[] = [];

      for (const [name, data] of industryMap) {
        // Sort stocks by short percent descending
        data.stocks.sort((a, b) => b.shortPercent - a.shortPercent);

        industries.push({
          name,
          slug: createSlug(name),
          stockCount: data.stocks.length,
          avgShortPercent: data.stocks.length > 0 ? data.totalPercent / data.stocks.length : 0,
          totalShortPercent: data.totalPercent,
          topStock: data.stocks[0] ? {
            code: data.stocks[0].code,
            name: data.stocks[0].code, // TreeMap doesn't have names, use code
            shortPercent: data.stocks[0].shortPercent,
          } : null,
        });
      }

      // Sort by stock count descending (most populated industries first)
      industries.sort((a, b) => b.stockCount - a.stockCount);

      return industries;
    },
    3600, // 1 hour cache
  );
});

// Get stocks for a specific industry
export const getIndustryStocks = cache(
  async (industrySlug: string): Promise<{
    industry: IndustryStats | null;
    stocks: Array<{
      code: string;
      name: string;
      shortPercent: number;
      change?: number;
    }>;
  }> => {
    const cacheKey = `${CACHE_KEYS.industryTreeMap("3m", 50, "current")}:industry:${industrySlug}`;

    return getOrSetCached(
      cacheKey,
      async () => {
        const baseUrl = process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT ?? SHORTS_API_URL;

        // Use direct fetch to avoid protobuf-es SSR issues
        const fetchResponse = await fetch(
          `${baseUrl}/shorts.v1alpha1.ShortedStocksService/GetIndustryTreeMap`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              period: "3m",
              limit: 50,
              viewMode: VIEW_MODE_CURRENT_CHANGE,
            }),
          }
        );

        if (!fetchResponse.ok) {
          throw new Error(`API returned ${fetchResponse.status}`);
        }

        const response = (await fetchResponse.json()) as TreeMapResponse;

        // Find stocks matching the industry slug
        const matchingStocks: Array<{
          code: string;
          name: string;
          shortPercent: number;
          change: number;
          industry: string;
        }> = [];

        for (const stock of response.stocks) {
          let industry = stock.industry?.trim() ?? "Other";
          if (INVALID_INDUSTRIES.has(industry)) {
            industry = "Other";
          }
          const slug = createSlug(industry);

          if (slug === industrySlug) {
            const shortPercent = stock.shortPosition ?? 0;

            matchingStocks.push({
              code: stock.productCode ?? "",
              name: stock.productCode ?? "", // TreeMap doesn't have names
              shortPercent,
              change: 0, // Would need separate API call for historical comparison
              industry,
            });
          }
        }

        // Sort by short percent descending
        matchingStocks.sort((a, b) => b.shortPercent - a.shortPercent);

        if (matchingStocks.length === 0) {
          return { industry: null, stocks: [] };
        }

        const industryName = matchingStocks[0]?.industry ?? "Unknown";
        const totalPercent = matchingStocks.reduce((sum, s) => sum + s.shortPercent, 0);

        return {
          industry: {
            name: industryName,
            slug: industrySlug,
            stockCount: matchingStocks.length,
            avgShortPercent: totalPercent / matchingStocks.length,
            totalShortPercent: totalPercent,
            topStock: matchingStocks[0] ?? null,
          },
          stocks: matchingStocks,
        };
      },
      3600, // 1 hour cache
    );
  }
);

// Get all industry slugs for static generation
export async function getAllIndustrySlugs(): Promise<string[]> {
  const industries = await getIndustryData();
  return industries.map((i) => i.slug);
}
