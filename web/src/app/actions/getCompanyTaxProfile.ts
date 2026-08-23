import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { StockService } from "~/gen/shorts/v1alpha1/stock_pb";
import { type GetCompanyTaxProfileResponse } from "~/gen/shorts/v1alpha1/stock_pb";
import { cache } from "react";
import { SHORTS_API_URL, serverFetchWithUserAgent } from "./config";
import { withRetryAndNotFound } from "./withRetry";

export const getCompanyTaxProfile = cache(
  withRetryAndNotFound(
    async (productCode: string): Promise<GetCompanyTaxProfileResponse> => {
      const transport = createConnectTransport({
        // NOT the bare global `fetch`: that sends no first-party user-agent and
        // no SSR bypass header, so the Cloudflare edge cannot tell this call
        // from a scraper and buckets it as anonymous.
        fetch: serverFetchWithUserAgent,
        baseUrl: SHORTS_API_URL,
      });
      const client = createClient(StockService, transport);
      return await client.getCompanyTaxProfile({ productCode });
    },
  ),
);
