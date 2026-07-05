import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";
import { cache } from "react";
import { SHORTS_API_URL, serverFetchWithUserAgent } from "../config";
import { withRetry, withRetryAndNotFound } from "../withRetry";

export const getMarketByDate = cache(
  withRetryAndNotFound(async (date: string, limit?: number, offset?: number) => {
    const transport = createConnectTransport({
      fetch: serverFetchWithUserAgent,
      baseUrl: SHORTS_API_URL,
    });
    const client = createClient(ShortedStocksService, transport);
    return client.getMarketByDate({ date, limit: limit ?? 50, offset: offset ?? 0 });
  }),
);

export const getAvailableDates = cache(
  withRetry(async (limit?: number, before?: string) => {
    const transport = createConnectTransport({
      fetch: serverFetchWithUserAgent,
      baseUrl: SHORTS_API_URL,
    });
    const client = createClient(ShortedStocksService, transport);
    return client.getAvailableDates({ limit: limit ?? 90, before: before ?? "" });
  }),
);
