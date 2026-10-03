import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { type GetAvailableDatesResponse, type GetMarketByDateResponse } from "~/gen/shorts/v1alpha1/market_pb";
import { MarketService } from "~/gen/shorts/v1alpha1/market_pb";
import { cache } from "react";
import { unstable_cache } from "next/cache";
import { SHORTS_API_URL, serverFetchWithUserAgent, serverFetchOutsideNextCache } from "../config";
import { fetchEdgeReadJson } from "../edgeRead";
import { toNextDataCacheValue } from "../stockPageCache";
import { withRetry, withRetryAndNotFound } from "../withRetry";

export function isValidMarketDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

async function fetchMarketByDate(
  date: string,
  limit = 50,
  offset = 0,
): Promise<GetMarketByDateResponse | null> {
  try {
    const edgeResponse = await fetchEdgeReadJson<GetMarketByDateResponse>(
      "/edge/v1/market-by-date",
      {
        date,
        limit,
        offset,
      },
      [`market-date:${date}`],
    );
    if (edgeResponse) return edgeResponse;

    const transport = createConnectTransport({
      // The outer unstable_cache owns persistence. A Connect POST through
      // Next's patched fetch would otherwise opt its page out of ISR.
      fetch: serverFetchOutsideNextCache,
      baseUrl: SHORTS_API_URL,
    });
    const client = createClient(MarketService, transport);
    return await client.getMarketByDate({ date, limit, offset });
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === 5
    ) {
      return null;
    }
    throw error;
  }
}

function getCachedMarketByDate(
  date: string,
  limit = 50,
  offset = 0,
): Promise<GetMarketByDateResponse | null> {
  return unstable_cache(
    async () => {
      const response = await fetchMarketByDate(date, limit, offset);
      // Protobuf stocks contain bigint fields, which JSON-based Next data
      // caching cannot serialize. Match the existing stock-page cache codec.
      return response ? toNextDataCacheValue(response) as unknown as GetMarketByDateResponse : null;
    },
    ["market-by-date", date, String(limit), String(offset)],
    { revalidate: 86400, tags: ["shorts-data", `market-date:${date}`] },
  )();
}

// Failed generations retain their last good page; only successful absence
// (empty snapshot or NotFound) may become a cached 404.
export const getMarketByDateStrict = cache(withRetry(getCachedMarketByDate));

export const getMarketByDate = cache(
  withRetryAndNotFound(async (date: string, limit?: number, offset?: number) =>
    (await getCachedMarketByDate(date, limit, offset)) ?? undefined,
  ),
);

export const getAvailableDates = cache(
  withRetry(async (limit?: number, before?: string) => {
    const edgeResponse = await fetchEdgeReadJson<GetAvailableDatesResponse>(
      "/edge/v1/available-dates",
      {
        limit: limit ?? 90,
        before: before !== "" ? before : undefined,
      },
    );
    if (edgeResponse) return edgeResponse;

    const transport = createConnectTransport({
      fetch: serverFetchWithUserAgent,
      baseUrl: SHORTS_API_URL,
    });
    const client = createClient(MarketService, transport);
    return client.getAvailableDates({ limit: limit ?? 90, before: before ?? "" });
  }),
);
