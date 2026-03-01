import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";
import { cache } from "react";
import { SHORTS_API_URL } from "../config";
import { withRetry, withRetryAndNotFound } from "../withRetry";

function getApiUrl() {
  return process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT ?? SHORTS_API_URL;
}

export const getMarketByDate = cache(
  withRetryAndNotFound(async (date: string, limit?: number, offset?: number) => {
    const transport = createConnectTransport({
      baseUrl: getApiUrl(),
    });
    const client = createClient(ShortedStocksService, transport);
    return client.getMarketByDate({ date, limit: limit ?? 50, offset: offset ?? 0 });
  }),
);

export const getAvailableDates = cache(
  withRetry(async (limit?: number, before?: string) => {
    const transport = createConnectTransport({
      baseUrl: getApiUrl(),
    });
    const client = createClient(ShortedStocksService, transport);
    return client.getAvailableDates({ limit: limit ?? 90, before: before ?? "" });
  }),
);
