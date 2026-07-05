import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";
import { type GetStockNewsResponse } from "~/gen/shorts/v1alpha1/shorts_pb";
import { cache } from "react";
import { SERVER_SHORTS_API_URL, serverFetchWithUserAgent } from "./config";
import { withRetryAndNotFound } from "./withRetry";

function createNewsClient() {
  const transport = createConnectTransport({
    fetch: serverFetchWithUserAgent,
    baseUrl: SERVER_SHORTS_API_URL,
  });
  return createClient(ShortedStocksService, transport);
}

export const getStockNews = cache(
  withRetryAndNotFound(
    async (
      stockCode: string,
      limit: number = 20, // eslint-disable-line @typescript-eslint/no-inferrable-types
    ): Promise<GetStockNewsResponse> => {
      const client = createNewsClient();
      const response = await client.getStockNews({ stockCode, limit });
      return response;
    },
  ),
);

export const getMarketNews = cache(
  withRetryAndNotFound(
    async (
      limit: number = 50, // eslint-disable-line @typescript-eslint/no-inferrable-types
      priceSensitiveOnly: boolean = false, // eslint-disable-line @typescript-eslint/no-inferrable-types
    ): Promise<GetStockNewsResponse> => {
      const client = createNewsClient();
      const response = await client.getMarketNews({
        limit,
        priceSensitiveOnly,
      });
      return response as unknown as GetStockNewsResponse;
    },
  ),
);
