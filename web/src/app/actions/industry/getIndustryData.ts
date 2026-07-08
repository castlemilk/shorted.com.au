"use server";

import { SHORTS_API_URL, serverFetchWithUserAgent } from "../config";
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

interface IndustryStocksResult {
  industry: IndustryStats | null;
  stocks: Array<{
    code: string;
    name: string;
    shortPercent: number;
    change?: number;
  }>;
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
  if (process.env.SKIP_STATIC_GENERATION === "1") {
    return [];
  }

  const cacheKey = `${CACHE_KEYS.industryTreeMap("max", 50, "current")}:industries-index:v2`;

  try {
    return await getOrSetCached(
      cacheKey,
      async () => {
        try {
          const baseUrl = SHORTS_API_URL;

          const fetchResponse = await serverFetchWithUserAgent(
            `${baseUrl}/shorts.v1alpha1.ShortedStocksService/GetIndustryTreeMap`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                period: "max",
                limit: 50,
                viewMode: VIEW_MODE_CURRENT_CHANGE,
              }),
            },
          );

          if (!fetchResponse.ok) {
            throw new Error(
              `getIndustryData: API returned ${fetchResponse.status}`,
            );
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
              avgShortPercent:
                data.stocks.length > 0
                  ? data.totalPercent / data.stocks.length
                  : 0,
              totalShortPercent: data.totalPercent,
              topStock: data.stocks[0]
                ? {
                    code: data.stocks[0].code,
                    name: data.stocks[0].code,
                    shortPercent: data.stocks[0].shortPercent,
                  }
                : null,
            });
          }

          industries.sort((a, b) => b.stockCount - a.stockCount);

          if (industries.length === 0) {
            throw new Error("getIndustryData: API returned no industry rows");
          }

          return industries;
        } catch (error) {
          throw error;
        }
      },
      3600, // 1 hour cache
    );
  } catch (error) {
    console.warn("getIndustryData: fetch failed, returning empty:", error);
    return [];
  }
});

// Get stocks for a specific industry
export const getIndustryStocks = cache(
  async (industrySlug: string): Promise<IndustryStocksResult> => {
    if (process.env.SKIP_STATIC_GENERATION === "1") {
      return { industry: null, stocks: [] };
    }

    const cacheKey = `${CACHE_KEYS.industryTreeMap("3m", 50, "current")}:industry:${industrySlug}:v2`;

    try {
      return await getOrSetCached(
        cacheKey,
        async () => {
          try {
            const baseUrl = SHORTS_API_URL;

            const fetchResponse = await serverFetchWithUserAgent(
              `${baseUrl}/shorts.v1alpha1.ShortedStocksService/GetIndustryTreeMap`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  period: "3m",
                  limit: 50,
                  viewMode: VIEW_MODE_CURRENT_CHANGE,
                }),
              },
            );

            if (!fetchResponse.ok) {
              throw new Error(
                `getIndustryStocks: API returned ${fetchResponse.status}`,
              );
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
                  name: stock.productCode ?? "",
                  shortPercent,
                  change: 0,
                  industry,
                });
              }
            }

            matchingStocks.sort((a, b) => b.shortPercent - a.shortPercent);

            if (matchingStocks.length === 0) {
              throw new Error(
                `getIndustryStocks: API returned no rows for ${industrySlug}`,
              );
            }

            const industryName = matchingStocks[0]?.industry ?? "Unknown";
            const totalPercent = matchingStocks.reduce(
              (sum, s) => sum + s.shortPercent,
              0,
            );

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
          } catch (error) {
            throw error;
          }
        },
        3600, // 1 hour cache
      );
    } catch (error) {
      console.warn("getIndustryStocks: fetch failed, returning empty:", error);
      return { industry: null, stocks: [] };
    }
  },
);

// Get all industry slugs for static generation
export async function getAllIndustrySlugs(): Promise<string[]> {
  const industries = await getIndustryData();
  return industries.map((i) => i.slug);
}
