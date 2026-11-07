import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { MarketService } from "~/gen/shorts/v1alpha1/market_pb";
import { type GetBattlegroundStocksResponse, type BattlegroundView } from "~/gen/shorts/v1alpha1/market_pb";
import { cache } from "react";
import { SHORTS_API_URL, serverFetchWithUserAgent } from "./config";
import { withRetryAndNotFound } from "./withRetry";
import { shortsLatestCacheTags } from "./stockPageCache";

// ISR-tagged transport (getEconomy's isrEconomyFetch pattern). The `next`
// option is LOAD-BEARING: without it serverFetchWithUserAgent forces
// `cache: "no-store"` on this POST at Vercel runtime, the no-store fetch throws
// inside /battlegrounds' static render, and Next discards every regeneration.
// Measured 2026-10-21: 4.4 s on the request after a purge, then STALE on every
// request with a frozen `age`, so the server-rendered rows never refreshed.
// Tagged `shorts-data` so the daily sync's revalidation busts it with every
// other ASIC-derived read. The POST body is a byte array, so
// serverFetchWithUserAgent keeps the response out of Next's data cache and
// applies this revalidate and these tags to the route (applyRoutePolicy,
// config.ts). Nothing is stored, so an empty response is not served from cache
// for the whole revalidate window.
const isrBattlegroundsFetch: typeof fetch = (input, init) =>
  serverFetchWithUserAgent(input, {
    ...init,
    next: { revalidate: 3600, tags: shortsLatestCacheTags("battlegrounds") },
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
