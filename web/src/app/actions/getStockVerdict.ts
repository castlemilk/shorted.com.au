import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";
import { type GetStockVerdictResponse } from "~/gen/shorts/v1alpha1/shorts_pb";
import { cache } from "react";
import { SHORTS_API_URL, serverFetchWithUserAgent } from "./config";
import { withRetryAndNotFound } from "./withRetry";

export const getStockVerdict = cache(
  withRetryAndNotFound(
    async (productCode: string): Promise<GetStockVerdictResponse> => {
      const transport = createConnectTransport({
        fetch: serverFetchWithUserAgent,
        baseUrl: SHORTS_API_URL,
      });
      const client = createClient(ShortedStocksService, transport);
      return await client.getStockVerdict({ productCode });
    },
  ),
);
