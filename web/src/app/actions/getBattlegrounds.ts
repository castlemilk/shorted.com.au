import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { MarketService } from "~/gen/shorts/v1alpha1/market_pb";
import { type GetBattlegroundStocksResponse, type BattlegroundView } from "~/gen/shorts/v1alpha1/market_pb";
import { cache } from "react";
import { SHORTS_API_URL, serverFetchWithUserAgent } from "./config";
import { withRetryAndNotFound } from "./withRetry";

// ISR-tagged transport (getEconomy's isrEconomyFetch pattern). The `next`
// option is LOAD-BEARING: without it serverFetchWithUserAgent forces
// `cache: "no-store"` on this POST at Vercel runtime, the no-store fetch throws
// inside /battlegrounds' static render, and Next discards every regeneration.
// Measured 2026-10-21: 4.4 s on the request after a purge, then STALE on every
// request with a frozen `age`, so the server-rendered rows never refreshed.
// Tagged `shorts-data` so the daily sync's revalidation busts it with every
// other ASIC-derived read. Next generally cannot key a streamed Connect POST
// body ("Failed to generate cache key", benign): the point is that the
// regeneration completes.
const isrBattlegroundsFetch: typeof fetch = (input, init) =>
  serverFetchWithUserAgent(input, {
    ...init,
    next: { revalidate: 3600, tags: ["shorts-data", "battlegrounds"] },
  } as RequestInit);

export const getBattlegrounds = cache(
  withRetryAndNotFound(
    async (
      view: BattlegroundView,
      limit = 25,
      offset = 0,
    ): Promise<GetBattlegroundStocksResponse> => {
      const transport = createConnectTransport({
        fetch: isrBattlegroundsFetch,
        baseUrl: SHORTS_API_URL,
      });
      const client = createClient(MarketService, transport);
      return await client.getBattlegroundStocks({
        view,
        limit: Number(limit),
        offset: Number(offset),
      });
    },
  ),
);
