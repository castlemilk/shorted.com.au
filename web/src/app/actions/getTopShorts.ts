import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { MarketService } from "~/gen/shorts/v1alpha1/market_pb";
import { type GetTopShortsResponse } from "~/gen/shorts/v1alpha1/market_pb";
import { formatPeriodForAPI } from "~/lib/period-utils";
import { SHORTS_API_URL, serverFetchWithUserAgent } from "./config";
import { cache } from "react";
import { fetchEdgeReadJson } from "./edgeRead";
import {
  CACHE_KEYS,
  HOMEPAGE_TTL,
  deleteCached,
  getCached,
  setCached,
} from "~/@/lib/kv-cache";
import { withRetryAndNotFound } from "./withRetry";
import { withSpan } from "~/@/lib/tracing";
import {
  filterTopShortsResponse,
  hasOnlyEligibleTopShortsInstruments,
} from "~/@/lib/top-shorts-filter";
import { isCachedShortsDataStale } from "~/@/lib/cache-freshness";

function isUsableTopShortsResponse(
  response: GetTopShortsResponse | null,
  offset: number,
): response is GetTopShortsResponse {
  if (!response || !Array.isArray(response.timeSeries)) return false;
  return (
    (response.timeSeries.length > 0 || offset > 0) &&
    hasOnlyEligibleTopShortsInstruments(response.timeSeries)
  );
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
      // Structurally usable AND not frozen — see isCachedShortsDataStale and the
      // 2026-08-21 read-only-cache incident. Applied to the cached entry only;
      // a freshly fetched response is served whatever its date.
      if (
        isUsableTopShortsResponse(cached, offset) &&
        !isCachedShortsDataStale(cached.timeSeries)
      ) {
        return cached;
      }
      if (cached !== null) {
        await deleteCached(cacheKey);
      }

      const response = await withSpan(
        "shorts.fetch.top",
        { period, limit, offset },
        async () => {
          const apiPeriod = formatPeriodForAPI(period);
          const edgeResponse = await fetchEdgeReadJson<GetTopShortsResponse>(
            "/edge/v1/top-shorts",
            {
              period: apiPeriod,
              limit,
              offset: offset > 0 ? offset : undefined,
            },
          );
          if (edgeResponse) return edgeResponse;

          const transport = createConnectTransport({
            fetch: serverFetchWithUserAgent,
            baseUrl: SHORTS_API_URL,
          });

          const client = createClient(MarketService, transport);
          return client.getTopShorts({
            period: apiPeriod,
            limit,
            offset,
          });
        },
      );

      const filteredResponse = filterTopShortsResponse(response);

      if (isUsableTopShortsResponse(filteredResponse, offset)) {
        setCached(cacheKey, filteredResponse, Number(HOMEPAGE_TTL)).catch((error) => {
          console.error(`Failed to cache top shorts for key ${cacheKey}:`, error);
        });
      }

      return filteredResponse;
    },
  ),
);

// A connect transport whose fetch is ISR-cacheable (next:{revalidate}) — a bare
// connect POST forces cache:'no-store' at Vercel runtime, which would opt the
// caller's route out of static generation (e.g. flip /industry-intelligence from
// ○ static to ƒ dynamic). Mirrors getIndustryData / fetchIndustryByCode.
function createIsrTopShortsClient(revalidateSeconds: number) {
  const isrFetch: typeof fetch = (input, init) =>
    serverFetchWithUserAgent(input, {
      ...init,
      next: { revalidate: revalidateSeconds },
    });
  const transport = createConnectTransport({
    fetch: isrFetch,
    baseUrl: SHORTS_API_URL,
  });
  return createClient(MarketService, transport);
}

/**
 * Names + latest short position for the top `limit` stocks, WITHOUT time-series
 * points (summary_only) — ~102KB vs ~3.19MB for the full 2y×1000 payload. Used
 * for name/industry enrichment where the points aren't needed.
 */
export const getTopShortsSummary = cache(
  withRetryAndNotFound(
    async (period: string, limit: number): Promise<GetTopShortsResponse> => {
      const client = createIsrTopShortsClient(1800);
      return client.getTopShorts({ period, limit, offset: 0, summaryOnly: true });
    },
  ),
);

/**
 * Time series for an EXPLICIT set of product codes (industry-crowding
 * constituents), instead of every top-N stock's points. `limit: 1000` is a
 * graceful-degradation fallback: an older backend that predates the
 * product_codes field ignores it and returns the top-1000 superset (correct,
 * just unoptimised), so this is safe to deploy before the backend ships.
 */
export const getTopShortsByCodes = cache(
  withRetryAndNotFound(
    async (
      period: string,
      codes: string[],
    ): Promise<GetTopShortsResponse> => {
      if (codes.length === 0) {
        return { $typeName: "shorts.v1alpha1.GetTopShortsResponse", timeSeries: [], offset: 0 } as GetTopShortsResponse;
      }
      const client = createIsrTopShortsClient(1800);
      return client.getTopShorts({
        period,
        limit: 1000,
        offset: 0,
        productCodes: codes,
      });
    },
  ),
);
