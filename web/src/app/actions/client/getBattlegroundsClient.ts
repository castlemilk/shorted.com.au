import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { MarketService } from "~/gen/shorts/v1alpha1/market_pb";
import { type GetBattlegroundStocksResponse, type BattlegroundView } from "~/gen/shorts/v1alpha1/market_pb";
import { SHORTS_API_URL } from "../config";
import { retryWithBackoff } from "@/lib/retry";
import { getSessionCached, setSessionCached } from "@/lib/session-cache";

const RETRY_OPTIONS = {
  maxRetries: 3,
  initialDelayMs: 500,
  maxDelayMs: 5000,
};

/**
 * Client-side version of getBattlegrounds
 * Calls the backend API directly from the browser
 * Uses sessionStorage cache (5-min TTL) to avoid redundant fetches
 * Includes retry logic for transient failures
 */
export const getBattlegroundsClient = async (
  view: BattlegroundView,
  limit = 25,
  offset = 0,
  forceRefresh = false,
): Promise<GetBattlegroundStocksResponse> => {
  const cacheKey = `battlegrounds:${view}:${limit}:${offset}`;

  if (!forceRefresh) {
    const cached = getSessionCached<GetBattlegroundStocksResponse>(cacheKey);
    if (cached) return cached;
  }

  // Use relative URL so requests go through Next.js rewrites (avoids CORS)
  const transport = createConnectTransport({
    baseUrl: typeof window !== "undefined" ? "" : SHORTS_API_URL,
  });

  const client = createClient(MarketService, transport);

  const result = await retryWithBackoff(
    () =>
      client.getBattlegroundStocks({
        view,
        limit,
        offset,
      }),
    RETRY_OPTIONS,
  );

  setSessionCached(cacheKey, result);
  return result;
};
