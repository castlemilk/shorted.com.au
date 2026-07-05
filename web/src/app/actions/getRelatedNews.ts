import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";
import { type GetRelatedNewsResponse } from "~/gen/shorts/v1alpha1/shorts_pb";
import { cache } from "react";
import { SERVER_SHORTS_API_URL, serverFetchWithUserAgent } from "./config";
import { withRetryAndNotFound } from "./withRetry";

export const getRelatedNews = cache(
  withRetryAndNotFound(
    async (
      stockCode: string,
      limit: number = 6, // eslint-disable-line @typescript-eslint/no-inferrable-types
      articleId: string = "", // eslint-disable-line @typescript-eslint/no-inferrable-types
    ): Promise<GetRelatedNewsResponse> => {
      const transport = createConnectTransport({
        fetch: serverFetchWithUserAgent,
        baseUrl: SERVER_SHORTS_API_URL,
      });
      const client = createClient(ShortedStocksService, transport);
      return client.getRelatedNews({ stockCode, limit, articleId });
    },
  ),
);
