import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { StockService } from "~/gen/shorts/v1alpha1/stock_pb";
import { type GetStockGraphResponse } from "~/gen/shorts/v1alpha1/stock_pb";
import { cache } from "react";
import { SHORTS_API_URL, serverFetchWithUserAgent } from "./config";
import { withRetryAndNotFound } from "./withRetry";

export const getStockGraph = cache(
  withRetryAndNotFound(
    async (
      stockCode: string,
      limit: number = 12, // eslint-disable-line @typescript-eslint/no-inferrable-types
    ): Promise<GetStockGraphResponse> => {
      const transport = createConnectTransport({
        fetch: serverFetchWithUserAgent,
        baseUrl: SHORTS_API_URL,
      });
      const client = createClient(StockService, transport);
      return client.getStockGraph({ stockCode, limit });
    },
  ),
);
