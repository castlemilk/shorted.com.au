import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";
import { type GetTopShortsResponse } from "~/gen/shorts/v1alpha1/shorts_pb";
import { formatPeriodForAPI } from "~/lib/period-utils";
import { SHORTS_API_URL } from "./config";
import { cache } from "react";
import { getOrSetCached, CACHE_KEYS, HOMEPAGE_TTL } from "~/@/lib/kv-cache";
import { withRetryAndNotFound } from "./withRetry";
import { withSpan } from "~/@/lib/tracing";

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

      return getOrSetCached(
        cacheKey,
        () =>
          withSpan(
            "shorts.fetch.top",
            { period, limit, offset },
            async () => {
              const transport = createConnectTransport({
                baseUrl:
                  process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT ??
                  SHORTS_API_URL,
              });

              const client = createClient(ShortedStocksService, transport);
              const response = await client.getTopShorts({
                period: formatPeriodForAPI(period),
                limit,
                offset,
              });
              return response;
            },
          ),
        Number(HOMEPAGE_TTL),
      );
    },
  ),
);
