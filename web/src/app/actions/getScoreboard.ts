import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";
import { type GetShortCampaignScoreboardResponse } from "~/gen/shorts/v1alpha1/shorts_pb";
import { cache } from "react";
import { SHORTS_API_URL } from "./config";
import { withRetryAndNotFound } from "./withRetry";

export const getScoreboard = cache(
  withRetryAndNotFound(
    async (
      limit?: number,
      offset?: number,
      industry?: string,
    ): Promise<GetShortCampaignScoreboardResponse> => {
      const transport = createConnectTransport({
        fetch,
        baseUrl: SHORTS_API_URL,
      });
      const client = createClient(ShortedStocksService, transport);
      return await client.getShortCampaignScoreboard({
        limit: Number(limit ?? 25),
        offset: Number(offset ?? 0),
        industry: industry ?? "",
      });
    },
  ),
);
