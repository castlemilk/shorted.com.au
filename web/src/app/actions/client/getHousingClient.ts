import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import {
  ShortedStocksService,
  type GetHousePriceSeriesResponse,
  type ListStateSuburbsResponse,
  type GetSuburbProfileResponse,
  type ListHousingRegionsResponse,
  type ListSuburbPriceDropsResponse,
  type ListSuburbDropListingsResponse,
  type ListAddressPriceDropsResponse,
  type GetPropertyHistoryResponse,
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

/** Browser-side housing-region list (powers the suburb explorer selector). */
export async function listHousingRegionsClient(
  regionType = "",
  stateCode = "",
  query = "",
  limit = 2000,
): Promise<ListHousingRegionsResponse | undefined> {
  const cacheKey = `housingRegions:${regionType}:${stateCode}:${query}:${limit}`;
  const cached = getSessionCached<ListHousingRegionsResponse>(cacheKey);
  if (cached) return cached;

  const transport = createConnectTransport({
    baseUrl: typeof window !== "undefined" ? "" : SHORTS_API_URL,
  });
  const client = createClient(ShortedStocksService, transport);

  try {
    const result = await retryWithBackoff(
      () => client.listHousingRegions({ regionType, stateCode, query, limit }),
      RETRY_OPTIONS,
    );
    setSessionCached(cacheKey, result);
    return result;
  } catch {
    return undefined;
  }
}

/** Browser-side suburb price-drop ranking (derived aggregate — no addresses). */
export async function listSuburbPriceDropsClient(
  stateCode = "",
  sort = "count",
  limit = 50,
): Promise<ListSuburbPriceDropsResponse | undefined> {
  const cacheKey = `suburbPriceDrops:${stateCode}:${sort}:${limit}`;
  const cached = getSessionCached<ListSuburbPriceDropsResponse>(cacheKey);
  if (cached) return cached;
  const transport = createConnectTransport({ baseUrl: typeof window !== "undefined" ? "" : SHORTS_API_URL });
  const client = createClient(ShortedStocksService, transport);
  try {
    const result = await retryWithBackoff(
      () => client.listSuburbPriceDrops({ stateCode, sort, limit }), RETRY_OPTIONS);
    setSessionCached(cacheKey, result);
    return result;
  } catch {
    return undefined;
  }
}

/** Browser-side per-suburb reduced-listings drill-down (deep-links out; flag-gated server-side). */
export async function listSuburbDropListingsClient(
  salCode = "",
  regionCode = "",
  windowDays = 30,
  limit = 30,
): Promise<ListSuburbDropListingsResponse | undefined> {
  const cacheKey = `suburbDropListings:${salCode}:${regionCode}:${windowDays}:${limit}`;
  const cached = getSessionCached<ListSuburbDropListingsResponse>(cacheKey);
  if (cached) return cached;
  const transport = createConnectTransport({ baseUrl: typeof window !== "undefined" ? "" : SHORTS_API_URL });
  const client = createClient(ShortedStocksService, transport);
  try {
    const result = await retryWithBackoff(
      () => client.listSuburbDropListings({ salCode, regionCode, windowDays, limit }), RETRY_OPTIONS);
    setSessionCached(cacheKey, result);
    return result;
  } catch {
    return undefined;
  }
}

/** Browser-side per-address price-drop ranking (deep-links to /housing/property/[addressKey]; flag-gated server-side). */
export async function listAddressPriceDropsClient(
  stateCode = "",
  windowDays = 90,
  limit = 50,
): Promise<ListAddressPriceDropsResponse | undefined> {
  const cacheKey = `addressPriceDrops:${stateCode}:${windowDays}:${limit}`;
  const cached = getSessionCached<ListAddressPriceDropsResponse>(cacheKey);
  if (cached) return cached;
  const transport = createConnectTransport({ baseUrl: typeof window !== "undefined" ? "" : SHORTS_API_URL });
  const client = createClient(ShortedStocksService, transport);
  try {
    const result = await retryWithBackoff(
      () => client.listAddressPriceDrops({ stateCode, windowDays, limit }), RETRY_OPTIONS);
    setSessionCached(cacheKey, result);
    return result;
  } catch {
    return undefined;
  }
}

/** Browser-side per-address price timeline (flag-gated server-side — see ListSuburbDropListings). */
export async function getPropertyHistoryClient(
  addressKey: string,
): Promise<GetPropertyHistoryResponse | undefined> {
  const cacheKey = `propertyHistory:${addressKey}`;
  const cached = getSessionCached<GetPropertyHistoryResponse>(cacheKey);
  if (cached) return cached;
  const transport = createConnectTransport({ baseUrl: typeof window !== "undefined" ? "" : SHORTS_API_URL });
  const client = createClient(ShortedStocksService, transport);
  try {
    const result = await retryWithBackoff(
      () => client.getPropertyHistory({ addressKey }), RETRY_OPTIONS);
    setSessionCached(cacheKey, result);
    return result;
  } catch {
    return undefined;
  }
}
