import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { StockService } from "~/gen/shorts/v1alpha1/stock_pb";
import { type GetCompanyTaxProfileResponse } from "~/gen/shorts/v1alpha1/stock_pb";
import { cache } from "react";
import { SHORTS_API_URL } from "./config";
import { withRetryAndNotFound } from "./withRetry";

export const getCompanyTaxProfile = cache(
  withRetryAndNotFound(
    async (productCode: string): Promise<GetCompanyTaxProfileResponse> => {
      const transport = createConnectTransport({
        fetch,
        baseUrl: SHORTS_API_URL,
      });
      const client = createClient(StockService, transport);
      return await client.getCompanyTaxProfile({ productCode });
    },
  ),
);
