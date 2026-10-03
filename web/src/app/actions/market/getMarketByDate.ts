import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { type GetAvailableDatesResponse, type GetMarketByDateResponse } from "~/gen/shorts/v1alpha1/market_pb";
import { MarketService } from "~/gen/shorts/v1alpha1/market_pb";
import { cache } from "react";
import { unstable_cache } from "next/cache";
import { SHORTS_API_URL, serverFetchOutsideNextCache } from "../config";
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

function getCachedAvailableDates(
  limit = 90,
  before = "",
): Promise<GetAvailableDatesResponse> {
  return unstable_cache(
    async () => {
      const edgeResponse = await fetchEdgeReadJson<GetAvailableDatesResponse>(
        "/edge/v1/available-dates",
        {
          limit,
          before: before || undefined,
        },
        ["market-index"],
      );
      if (edgeResponse) return edgeResponse;

      const transport = createConnectTransport({
        // ISR owns the response cache; a patched no-store Connect POST would
        // otherwise make the market index's regeneration render an empty shell.
        fetch: serverFetchOutsideNextCache,
        baseUrl: SHORTS_API_URL,
      });
      const client = createClient(MarketService, transport);
      const response = await client.getAvailableDates({ limit, before });
      return toNextDataCacheValue(response) as GetAvailableDatesResponse;
    },
    ["market-available-dates", String(limit), before],
    { revalidate: 3600, tags: ["shorts-data", "market-index"] },
  )();
}

// Keep errors visible to the ISR caller and cache successful empty indexes.
export const getAvailableDates = cache(withRetry(getCachedAvailableDates));
