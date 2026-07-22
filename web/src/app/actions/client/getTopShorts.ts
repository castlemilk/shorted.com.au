import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { MarketService } from "~/gen/shorts/v1alpha1/market_pb";
import { type GetTopShortsResponse } from "~/gen/shorts/v1alpha1/market_pb";
import { formatPeriodForAPI } from "~/lib/period-utils";
import { SHORTS_API_URL } from "../config";
import { retryWithBackoff } from "@/lib/retry";
import { getSessionCached, setSessionCached } from "@/lib/session-cache";
import {
  filterTopShortsResponse,
  hasOnlyEligibleTopShortsInstruments,
} from "@/lib/top-shorts-filter";

const RETRY_OPTIONS = {
  maxRetries: 3,
  initialDelayMs: 500,
  maxDelayMs: 5000,
};

/**
 * Client-side version of getTopShortsData
 * Calls the backend API directly from the browser
 * Uses sessionStorage cache (5-min TTL) to avoid redundant fetches
 * Includes retry logic for transient failures
 */
export const getTopShortsDataClient = async (
  period: string,
  limit: number,
  offset: number,
  forceRefresh = false,
): Promise<GetTopShortsResponse> => {
  const cacheKey = `topShorts:${period}:${limit}:${offset}`;

  if (!forceRefresh) {
    const cached = getSessionCached<GetTopShortsResponse>(cacheKey);
    if (
      cached &&
      Array.isArray(cached.timeSeries) &&
      hasOnlyEligibleTopShortsInstruments(cached.timeSeries)
    ) {
      return cached;
    }
  }

  // Use relative URL so requests go through Next.js rewrites (avoids CORS)
  const transport = createConnectTransport({
    baseUrl: typeof window !== "undefined" ? "" : SHORTS_API_URL,
  });

  const client = createClient(MarketService, transport);

  const result = await retryWithBackoff(
    () =>
      client.getTopShorts({
        period: formatPeriodForAPI(period),
        limit,
        offset,
      }),
    RETRY_OPTIONS,
  );

  const filteredResult = filterTopShortsResponse(result);
  setSessionCached(cacheKey, filteredResult);
  return filteredResult;
};
