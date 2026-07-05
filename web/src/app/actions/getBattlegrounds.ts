import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";
import {
  type GetBattlegroundStocksResponse,
  type BattlegroundView,
} from "~/gen/shorts/v1alpha1/shorts_pb";
import { cache } from "react";
import { SHORTS_API_URL, serverFetchWithUserAgent } from "./config";
import { withRetryAndNotFound } from "./withRetry";

export const getBattlegrounds = cache(
  withRetryAndNotFound(
    async (
      view: BattlegroundView,
      limit = 25,
      offset = 0,
    ): Promise<GetBattlegroundStocksResponse> => {
      const transport = createConnectTransport({
        fetch: serverFetchWithUserAgent,
        baseUrl: SHORTS_API_URL,
      });
      const client = createClient(ShortedStocksService, transport);
      return await client.getBattlegroundStocks({
        view,
        limit: Number(limit),
        offset: Number(offset),
      });
    },
  ),
);
