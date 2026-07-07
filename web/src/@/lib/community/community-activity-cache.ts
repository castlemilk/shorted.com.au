import { revalidateTag, unstable_cache } from "next/cache";
import {
  getCommunityThread,
  listCommunityComments,
  listCommunityPulseItems,
  listCommunityPulseReplies,
  listCommunityThreads,
} from "./community-repository";

export const COMMUNITY_PUBLIC_READ_CACHE_SECONDS = 60;
export const COMMUNITY_PUBLIC_READ_STALE_SECONDS = 300;
export const COMMUNITY_PUBLIC_READ_CACHE_CONTROL =
  `public, s-maxage=${COMMUNITY_PUBLIC_READ_CACHE_SECONDS}, stale-while-revalidate=${COMMUNITY_PUBLIC_READ_STALE_SECONDS}`;

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
  const normalizedStockCode = normalizeStockCode(stockCode);

  return unstable_cache(
    () => listCommunityThreads(normalizedStockCode),
    ["community-threads", normalizedStockCode],
    {
      revalidate: COMMUNITY_PUBLIC_READ_CACHE_SECONDS,
      tags: [communityThreadsCacheTag(normalizedStockCode)],
    },
  )();
}

export function getCachedCommunityPulseItems(stockCode: string) {
  const normalizedStockCode = normalizeStockCode(stockCode);

  return unstable_cache(
    () => listCommunityPulseItems(normalizedStockCode),
    ["community-pulse", normalizedStockCode],
    {
      revalidate: COMMUNITY_PUBLIC_READ_CACHE_SECONDS,
      tags: [communityPulseCacheTag(normalizedStockCode)],
    },
  )();
}

export function getCachedCommunityThread(stockCode: string, threadId: string) {
  const normalizedStockCode = normalizeStockCode(stockCode);
  const normalizedThreadId = normalizeId(threadId);

  return unstable_cache(
    () => getCommunityThread(normalizedStockCode, normalizedThreadId),
    ["community-thread", normalizedStockCode, normalizedThreadId],
    {
      revalidate: COMMUNITY_PUBLIC_READ_CACHE_SECONDS,
      tags: [communityThreadCacheTag(normalizedStockCode, normalizedThreadId)],
    },
  )();
}

export function getCachedCommunityComments(stockCode: string, threadId: string) {
  const normalizedStockCode = normalizeStockCode(stockCode);
  const normalizedThreadId = normalizeId(threadId);

  return unstable_cache(
    () => listCommunityComments(normalizedStockCode, normalizedThreadId),
    ["community-thread-comments", normalizedStockCode, normalizedThreadId],
    {
      revalidate: COMMUNITY_PUBLIC_READ_CACHE_SECONDS,
      tags: [
        communityThreadCommentsCacheTag(normalizedStockCode, normalizedThreadId),
      ],
    },
  )();
}

export function getCachedCommunityPulseReplies(
  stockCode: string,
  pulseId: string,
) {
  const normalizedStockCode = normalizeStockCode(stockCode);
  const normalizedPulseId = normalizeId(pulseId);

  return unstable_cache(
    () => listCommunityPulseReplies(normalizedStockCode, normalizedPulseId),
    ["community-pulse-replies", normalizedStockCode, normalizedPulseId],
    {
      revalidate: COMMUNITY_PUBLIC_READ_CACHE_SECONDS,
      tags: [
        communityPulseRepliesCacheTag(normalizedStockCode, normalizedPulseId),
      ],
    },
  )();
}

export function revalidateCommunityCacheTags(tags: string[]) {
  for (const tag of tags) {
    revalidateTag(tag);
  }
}
