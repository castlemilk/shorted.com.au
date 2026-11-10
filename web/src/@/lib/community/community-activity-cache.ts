import { revalidateTag, unstable_noStore as noStore } from "next/cache";
import {
  getCommunityThread,
  listCommunityComments,
  listCommunityPulseItems,
  listCommunityPulseReplies,
  listCommunityThreads,
} from "./community-repository";

// Moderation can change outside this application. Never replay a formerly
// public record from the Data Cache or a CDN until all status mutations have
// a guaranteed invalidation path. Keep the loader names for existing callers.
export const COMMUNITY_PUBLIC_READ_CACHE_CONTROL = "no-store";

function normalizeStockCode(stockCode: string) {
  return stockCode.toUpperCase();
}

function normalizeId(id: string) {
  return id.trim();
}

export function communityThreadsCacheTag(stockCode: string) {
  return `community-threads:${normalizeStockCode(stockCode)}`;
}

export function communityPulseCacheTag(stockCode: string) {
  return `community-pulse:${normalizeStockCode(stockCode)}`;
}

export function communityThreadCacheTag(stockCode: string, threadId: string) {
  return `community-thread:${normalizeStockCode(stockCode)}:${normalizeId(threadId)}`;
}

export function communityThreadCommentsCacheTag(
  stockCode: string,
  threadId: string,
) {
  return `community-thread-comments:${normalizeStockCode(stockCode)}:${normalizeId(threadId)}`;
}

export function communityPulseRepliesCacheTag(
  stockCode: string,
  pulseId: string,
) {
  return `community-pulse-replies:${normalizeStockCode(stockCode)}:${normalizeId(pulseId)}`;
}

export function getCachedCommunityThreads(stockCode: string) {
  noStore();
  return listCommunityThreads(normalizeStockCode(stockCode));
}

export function getCachedCommunityPulseItems(stockCode: string) {
  noStore();
  return listCommunityPulseItems(normalizeStockCode(stockCode));
}

export function getCachedCommunityThread(stockCode: string, threadId: string) {
  noStore();
  return getCommunityThread(
    normalizeStockCode(stockCode),
    normalizeId(threadId),
  );
}

export function getCachedCommunityComments(
  stockCode: string,
  threadId: string,
) {
  noStore();
  return listCommunityComments(
    normalizeStockCode(stockCode),
    normalizeId(threadId),
  );
}

export function getCachedCommunityPulseReplies(
  stockCode: string,
  pulseId: string,
) {
  noStore();
  return listCommunityPulseReplies(
    normalizeStockCode(stockCode),
    normalizeId(pulseId),
  );
}

export function revalidateCommunityCacheTags(tags: string[]) {
  for (const tag of tags) {
    revalidateTag(tag);
  }
}
