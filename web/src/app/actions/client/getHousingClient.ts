import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import {
  ShortedStocksService,
  type GetHousePriceSeriesResponse,
  type ListStateSuburbsResponse,
  type GetSuburbProfileResponse,
} from "~/gen/shorts/v1alpha1/shorts_pb";
import { SHORTS_API_URL } from "../config";
import { retryWithBackoff } from "@/lib/retry";
import { getSessionCached, setSessionCached } from "@/lib/session-cache";

const RETRY_OPTIONS = { maxRetries: 3, initialDelayMs: 500, maxDelayMs: 5000 };

/** Browser-side house-price series fetch (for interactive charts). */
export async function getHousePriceSeriesClient(
  regionCode: string,
  measure: string,
  dwellingType = "",
): Promise<GetHousePriceSeriesResponse | undefined> {
  const cacheKey = `housePriceSeries:${regionCode}:${measure}:${dwellingType}`;
  const cached = getSessionCached<GetHousePriceSeriesResponse>(cacheKey);
  if (cached) return cached;

  const transport = createConnectTransport({
    baseUrl: typeof window !== "undefined" ? "" : SHORTS_API_URL,
  });
  const client = createClient(ShortedStocksService, transport);

  try {
    const result = await retryWithBackoff(
      () => client.getHousePriceSeries({ regionCode, measure, dwellingType }),
      RETRY_OPTIONS,
    );
    setSessionCached(cacheKey, result);
    return result;
  } catch {
    return undefined;
  }
}

/** Browser-side list of a state's suburbs (powers the state map + list). */
export async function listStateSuburbsClient(
  stateCode: string,
  query = "",
  limit = 5000,
): Promise<ListStateSuburbsResponse | undefined> {
  const cacheKey = `stateSuburbs:${stateCode}:${query}:${limit}`;
  const cached = getSessionCached<ListStateSuburbsResponse>(cacheKey);
  if (cached) return cached;
  const transport = createConnectTransport({ baseUrl: typeof window !== "undefined" ? "" : SHORTS_API_URL });
  const client = createClient(ShortedStocksService, transport);
  try {
    const result = await retryWithBackoff(
      () => client.listStateSuburbs({ stateCode, query, limit }), RETRY_OPTIONS);
    setSessionCached(cacheKey, result);
    return result;
  } catch {
    return undefined;
  }
}

/** Browser-side suburb profile fetch (hover sparkline + detail). */
export async function getSuburbProfileClient(
  salCode: string,
): Promise<GetSuburbProfileResponse | undefined> {
  const cacheKey = `suburbProfile:${salCode}`;
  const cached = getSessionCached<GetSuburbProfileResponse>(cacheKey);
  if (cached) return cached;
  const transport = createConnectTransport({ baseUrl: typeof window !== "undefined" ? "" : SHORTS_API_URL });
  const client = createClient(ShortedStocksService, transport);
  try {
    const result = await retryWithBackoff(() => client.getSuburbProfile({ salCode }), RETRY_OPTIONS);
    setSessionCached(cacheKey, result);
    return result;
  } catch {
    return undefined;
  }
}
