import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { StockService } from "~/gen/shorts/v1alpha1/stock_pb";
import { type GetDividendHistoryResponse } from "~/gen/shorts/v1alpha1/stock_pb";
import { cache } from "react";
import { SHORTS_API_URL, serverFetchWithUserAgent } from "./config";
import { withRetryAndNotFound } from "./withRetry";

export const getDividendHistory = cache(
  withRetryAndNotFound(
    async (
      stockCode: string,
      years: number = 5, // eslint-disable-line @typescript-eslint/no-inferrable-types
    ): Promise<GetDividendHistoryResponse> => {
      const transport = createConnectTransport({
        fetch: serverFetchWithUserAgent,
        baseUrl: SHORTS_API_URL,
      });
      const client = createClient(StockService, transport);
      const response = await client.getDividendHistory({ stockCode, years });
      return response;
    },
  ),
);
