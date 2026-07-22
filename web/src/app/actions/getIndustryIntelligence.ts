import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { unstable_cache } from "next/cache";
import { cache } from "react";

import { type GetIndustryIntelligenceResponse } from "~/gen/shorts/v1alpha1/industry_pb";
import { IndustryIntelligenceService } from "~/gen/shorts/v1alpha1/industry_pb";
import {
  toSnapshot,
  type IndustryIntelligenceSnapshot,
} from "~/@/lib/industry-intelligence-snapshot";
import { CACHE_KEYS, getOrSetCached } from "~/@/lib/kv-cache";
import { SERVER_SHORTS_API_URL, serverFetchOutsideNextCache } from "./config";
import { withRetryAndNotFound } from "./withRetry";

// Re-export for existing consumers; the projection lives in a pure shared
// module so client fetchers can use it too.
export type { IndustryIntelligenceSnapshot };

// Evidence changes only when the influence-collector imports land (weekly /
// on deploy). The key lives under the daily-flushed cache:homepage: prefix,
// so the 24h ceiling matches its siblings (top-shorts/treemap) instead of
// forcing ~23 extra per-industry re-fans per day at 1h.
const SNAPSHOT_TTL_SECONDS = 86400;

type GetIndustryIntelligenceAction = (
  industry: string,
  recordLimit?: number,
  stockCode?: string,
) => Promise<GetIndustryIntelligenceResponse>;

const fetchIndustryIntelligence: GetIndustryIntelligenceAction = async (
  industry,
  recordLimit = 50,
  stockCode = "",
) => {
  const transport = createConnectTransport({
    fetch: serverFetchOutsideNextCache,
    baseUrl: SERVER_SHORTS_API_URL,
  });
  const client = createClient(IndustryIntelligenceService, transport);
  return await client.getIndustryIntelligence({
    industry,
    recordLimit,
    stockCode,
  });
};

export const getIndustryIntelligence = cache(
  withRetryAndNotFound(fetchIndustryIntelligence),
);


// The connect fetch, projected to the plain snapshot, inside unstable_cache.
// This makes the call legal in ISR renders (the raw connect POST is forced
// no-store at Vercel runtime, which throws "Dynamic server usage" inside a
// revalidating route — the stock page hit this once it moved off
// force-dynamic). Errors are never cached (throw -> cache miss), and the
// projection (not the proto response) is stored because the raw response
// carries BigInt timestamps that don't JSON-serialize.
function fetchSnapshotCached(
  industry: string,
  recordLimit: number,
  stockCode: string,
): Promise<IndustryIntelligenceSnapshot> {
  return unstable_cache(
    async () => {
      const response = await getIndustryIntelligence(
        industry,
        recordLimit,
        stockCode,
      );
      if (!response) {
        throw new Error("industry intelligence unavailable");
      }
      const snapshot = toSnapshot(response);
      if (
        snapshot.sources.length === 0 &&
        snapshot.records.length === 0 &&
        snapshot.timeBuckets.length === 0
      ) {
        // Do not cache emptiness: sources flip public as imports land.
        throw new Error("industry intelligence empty");
      }
      return snapshot;
    },
    [
      "industry-intelligence-snapshot",
      industry || "all",
      String(recordLimit),
      stockCode || "none",
    ],
    { tags: ["industry-intelligence"], revalidate: SNAPSHOT_TTL_SECONDS },
  )();
}

/**
 * KV-cached (Redis, daily-flushed with the homepage prefix) evidence
 * snapshot for one industry, with a Next data-cache layer underneath for
 * ISR safety. Returns null when the backend is unreachable or has no data —
 * failures are never cached.
 */
export const getIndustryIntelligenceSnapshot = cache(
  async (
    industry: string,
    recordLimit = 50,
    stockCode = "",
  ): Promise<IndustryIntelligenceSnapshot | null> => {
    try {
      return await getOrSetCached(
        CACHE_KEYS.industryIntelligence(industry, recordLimit, stockCode),
        () => fetchSnapshotCached(industry, recordLimit, stockCode),
        SNAPSHOT_TTL_SECONDS,
      );
    } catch {
      return null;
    }
  },
);
