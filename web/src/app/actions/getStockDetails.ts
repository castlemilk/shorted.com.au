import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";
import { type StockDetails } from "~/gen/stocks/v1alpha1/stocks_pb";
import { cache } from "react";
import { SHORTS_API_URL } from "./config";
import { withRetryAndNotFound } from "./withRetry";

export const getStockDetails = cache(
  withRetryAndNotFound(async (productCode: string): Promise<StockDetails> => {
    const transport = createConnectTransport({
      fetch,
      baseUrl:
        process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT ?? SHORTS_API_URL,
    });
    const client = createClient(ShortedStocksService, transport);
    const response = await client.getStockDetails({ productCode });
    return response;
  }),
);
