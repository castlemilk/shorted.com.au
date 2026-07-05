import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";
import { type GetTopShortsResponse } from "~/gen/shorts/v1alpha1/shorts_pb";
import { formatPeriodForAPI } from "~/lib/period-utils";
import { SHORTS_API_URL, serverFetchWithUserAgent } from "./config";
import { cache } from "react";
import {
  CACHE_KEYS,
  HOMEPAGE_TTL,
  deleteCached,
  getCached,
  setCached,
} from "~/@/lib/kv-cache";
import { withRetryAndNotFound } from "./withRetry";
import { withSpan } from "~/@/lib/tracing";

function isUsableTopShortsResponse(
  response: GetTopShortsResponse | null,
  offset: number,
): response is GetTopShortsResponse {
  if (!response || !Array.isArray(response.timeSeries)) return false;
  return response.timeSeries.length > 0 || offset > 0;
}

// React cache() provides request deduplication during a single render
// This prevents duplicate fetches when the same data is needed by multiple components
// Now also uses KV cache for faster responses
// Uses withRetryAndNotFound to gracefully handle backend being unreachable during build
export const getTopShortsData = cache(
  withRetryAndNotFound(
    async (
      period: string,
      limit: number,
      offset: number,
    ): Promise<GetTopShortsResponse> => {
      const cacheKey = CACHE_KEYS.topShorts(period, limit, offset);

      const cached = await getCached<GetTopShortsResponse>(cacheKey);
      if (isUsableTopShortsResponse(cached, offset)) {
        return cached;
      }
      if (cached !== null) {
        await deleteCached(cacheKey);
      }

      const response = await withSpan(
        "shorts.fetch.top",
        { period, limit, offset },
        async () => {
          const transport = createConnectTransport({
            fetch: serverFetchWithUserAgent,
            baseUrl: SHORTS_API_URL,
          });

          const client = createClient(ShortedStocksService, transport);
          return client.getTopShorts({
            period: formatPeriodForAPI(period),
            limit,
            offset,
          });
        },
      );

      if (isUsableTopShortsResponse(response, offset)) {
        setCached(cacheKey, response, Number(HOMEPAGE_TTL)).catch((error) => {
          console.error(`Failed to cache top shorts for key ${cacheKey}:`, error);
        });
      }

      return response;
    },
  ),
);
