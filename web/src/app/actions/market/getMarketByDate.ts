import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { type GetAvailableDatesResponse, type GetMarketByDateResponse } from "~/gen/shorts/v1alpha1/market_pb";
import { MarketService } from "~/gen/shorts/v1alpha1/market_pb";
import { cache } from "react";
import { SHORTS_API_URL, serverFetchWithUserAgent } from "../config";
import { fetchEdgeReadJson } from "../edgeRead";
import { withRetry, withRetryAndNotFound } from "../withRetry";

export const getMarketByDate = cache(
  withRetryAndNotFound(async (date: string, limit?: number, offset?: number) => {
    const edgeResponse = await fetchEdgeReadJson<GetMarketByDateResponse>(
      "/edge/v1/market-by-date",
      {
        date,
        limit: limit ?? 50,
        offset: offset ?? 0,
      },
    );
    if (edgeResponse) return edgeResponse;

    const transport = createConnectTransport({
      fetch: serverFetchWithUserAgent,
      baseUrl: SHORTS_API_URL,
    });
    const client = createClient(MarketService, transport);
    return client.getMarketByDate({ date, limit: limit ?? 50, offset: offset ?? 0 });
  }),
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
