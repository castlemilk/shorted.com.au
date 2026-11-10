import { unstable_noStore as noStore } from "next/cache";
import { getStockCommunitySummary } from "./community-repository";

export function communitySummaryCacheTag(stockCode: string) {
  return `community-summary:${stockCode.toUpperCase()}`;
}

export function getCachedStockCommunitySummary(stockCode: string) {
  // Summary headlines can contain moderated thread text too.
  noStore();
  return getStockCommunitySummary(stockCode.toUpperCase());
}
