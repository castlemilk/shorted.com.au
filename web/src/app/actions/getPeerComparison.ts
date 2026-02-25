import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";
import { type GetPeerComparisonResponse } from "~/gen/shorts/v1alpha1/shorts_pb";
import { cache } from "react";
import { SHORTS_API_URL } from "./config";
import { withRetryAndNotFound } from "./withRetry";

export const getPeerComparison = cache(
  withRetryAndNotFound(
    async (
      stockCode: string,
      limit: number = 5, // eslint-disable-line @typescript-eslint/no-inferrable-types
    ): Promise<GetPeerComparisonResponse> => {
      const transport = createConnectTransport({
        fetch,
        baseUrl: SHORTS_API_URL,
      });
      const client = createClient(ShortedStocksService, transport);
      const response = await client.getPeerComparison({ stockCode, limit });
      return response;
    },
  ),
);
