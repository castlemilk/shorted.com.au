"use server";

import {
  SHORTS_API_URL,
  serverFetchOutsideNextCache,
  skipForBuild,
} from "../config";
import { sharedRead } from "../shared-read";
import { shortsLatestCacheTags } from "../stockPageCache";
import { cache } from "react";
import { getOrSetCached, CACHE_KEYS } from "~/@/lib/kv-cache";
import { industryLabel } from "~/@/lib/industry-placeholder";
import { createSlug } from "~/@/lib/industry-slug";

// ViewMode enum values - using constants to avoid protobuf-es SSR issues
const VIEW_MODE_CURRENT_CHANGE = 0;

// Both treemap reads below were `next: { revalidate: 1800 }` POSTs. The window
// now lives in one shared entry (shared-read.ts), which holds only good answers.
//
// The entry is tagged shorts-latest, so every sync that writes refreshes it at
// once; the window is only the backstop. It was 1800 and untagged: /industry
// lagged a sync by up to 30 minutes, and because the stock page's Overview and
// Company tabs read it (related stocks) and a route takes the shortest window
// it reads, those two tabs regenerated every 30 minutes rather than hourly.
const TREEMAP_REVALIDATE_SECONDS = 3600;

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
  // Why industry is null, when it is. "unknown-slug" = the feed answered and
  // this slug matches nothing (safe to noindex — it's a soft-404).
  // "unavailable" = build-skip or fetch failure (transient — callers must NOT
  // emit noindex, or a degraded regen would deindex a real industry page).
  reason?: "unknown-slug" | "unavailable";
}

// Build-phase-only data-fetch skip — shared helper (see actions/config.ts).

/**
 * One GetIndustryTreeMap answer for a period, shared by every caller in the
 * window (sharedRead). The industries index is force-dynamic, so without a
 * shared entry each page view would call the API while the KV layer is down:
 * the data cache used to hold this answer. An empty or failed answer throws,
 * so it is not held.
 */
function treeMapFor(period: "max" | "3m"): Promise<TreeMapResponse> {
  return sharedRead(
    ["industry-treemap", period, "50", "current", "v1"],
    TREEMAP_REVALIDATE_SECONDS,
    async () => {
      const fetchResponse = await serverFetchOutsideNextCache(
        `${SHORTS_API_URL}/shorts.v1alpha1.ShortedStocksService/GetIndustryTreeMap`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            period,
            limit: 50,
            viewMode: VIEW_MODE_CURRENT_CHANGE,
          }),
        },
      );
      if (!fetchResponse.ok) {
        throw new Error(
          `GetIndustryTreeMap ${period}: API returned ${fetchResponse.status}`,
        );
      }
      const response = (await fetchResponse.json()) as TreeMapResponse;
      if (!response.stocks || response.stocks.length === 0) {
        throw new Error(
          `GetIndustryTreeMap ${period}: API returned no industry rows`,
        );
      }
      return response;
    },
    shortsLatestCacheTags(),
  );
}

// Get aggregated industry statistics using IndustryTreeMap endpoint
export const getIndustryData = cache(async (): Promise<IndustryStats[]> => {
  if (skipForBuild()) {
    return [];
  }

  const cacheKey = `${CACHE_KEYS.industryTreeMap("max", 50, "current")}:industries-index:v2`;

  try {
    return await getOrSetCached(
      cacheKey,
      async () => {
        try {
          // Held in one shared entry (treeMapFor), so a KV outage costs one
          // call per window rather than one per page view.
          const response = await treeMapFor("max");

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
            // The ASX's placeholders for unclassified securities go in "Other".
            const industry = industryLabel(stock.industry) || "Other";
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

// One shared 3m treemap fetch: getIndustryStocks used to issue a byte-identical
// GetIndustryTreeMap POST per slug (8 concurrent copies on a cold render) and
// store 8 duplicate treemap responses in Redis under per-slug keys. React
// cache() dedupes within a render; one Redis key serves every slug.
const fetchTreeMap3m = cache(async (): Promise<TreeMapResponse> => {
  const cacheKey = `${CACHE_KEYS.industryTreeMap("3m", 50, "current")}:raw:v1`;
  // Never cache emptiness: treeMapFor throws on an empty answer, so a degraded
  // backend response cannot pin every industry empty for the TTL.
  return await getOrSetCached(
    cacheKey,
    () => treeMapFor("3m"),
    3600, // 1 hour cache
  );
});

// Get stocks for a specific industry
export const getIndustryStocks = cache(
  async (industrySlug: string): Promise<IndustryStocksResult> => {
    if (skipForBuild()) {
      return { industry: null, stocks: [], reason: "unavailable" };
    }

    try {
      const response = await fetchTreeMap3m();

      // Find stocks matching the industry slug
      const matchingStocks: Array<{
        code: string;
        name: string;
        shortPercent: number;
        change: number;
        industry: string;
      }> = [];

      for (const stock of response.stocks) {
        const industry = industryLabel(stock.industry) || "Other";
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
        // The feed answered and nothing matched: an unknown/typo'd slug, not
        // an outage. Distinguished from the catch below so the page can
        // noindex this soft-404 without ever noindexing on a transient error.
        return { industry: null, stocks: [], reason: "unknown-slug" };
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
      console.warn("getIndustryStocks: fetch failed, returning empty:", error);
      return { industry: null, stocks: [], reason: "unavailable" };
    }
  },
);

// Get all industry slugs for static generation
export async function getAllIndustrySlugs(): Promise<string[]> {
  const industries = await getIndustryData();
  return industries.map((i) => i.slug);
}
