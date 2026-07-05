import { unstable_cache } from "next/cache";
import { getStockCommunitySummary } from "./firestore-community";

export const COMMUNITY_SUMMARY_CACHE_SECONDS = 120;

export function communitySummaryCacheTag(stockCode: string) {
  return `community-summary:${stockCode.toUpperCase()}`;
}

export function getCachedStockCommunitySummary(stockCode: string) {
  const normalizedStockCode = stockCode.toUpperCase();

  return unstable_cache(
    () => getStockCommunitySummary(normalizedStockCode),
    ["community-summary", normalizedStockCode],
    {
      revalidate: COMMUNITY_SUMMARY_CACHE_SECONDS,
      tags: [communitySummaryCacheTag(normalizedStockCode)],
    },
  )();
}
