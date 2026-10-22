import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { MarketService } from "~/gen/shorts/v1alpha1/market_pb";
import { type IndustryTreeMap } from "~/gen/stocks/v1alpha1/stocks_pb";
import { type ViewMode } from "~/gen/shorts/v1alpha1/market_pb";
import { SHORTS_API_URL, serverFetchWithUserAgent } from "./config";
import { fetchEdgeReadJson } from "./edgeRead";
import { formatPeriodForAPI } from "~/lib/period-utils";
import { cache } from "react";
import { getOrSetCached, CACHE_KEYS, HOMEPAGE_TTL } from "~/@/lib/kv-cache";
import { withRetry } from "./withRetry";

// ISR-tagged transport (getBattlegrounds' isrBattlegroundsFetch pattern). The
// `next` option is LOAD-BEARING: without it serverFetchWithUserAgent forces
// `cache: "no-store"` on this POST at Vercel runtime, and inside the homepage's
// static render that fetch throws DynamicServerError, so a regeneration that
// missed the KV and the edge read was discarded. Only the warm-cache route
// keeping the KV filled hid it. Tagged `shorts-data` so the daily sync's
// revalidation busts it with the other ASIC reads; the lifetime is the KV's,
// which is also the homepage's revalidate.
const isrTreeMapFetch: typeof fetch = (input, init) =>
  serverFetchWithUserAgent(input, {
    ...init,
    next: { revalidate: HOMEPAGE_TTL, tags: ["shorts-data"] },
  } as RequestInit);

// React cache() provides request deduplication during a single render
// This prevents duplicate fetches when the same data is needed by multiple components
// Now also uses KV cache for faster responses
export const getIndustryTreeMap = cache(
  withRetry(
    async (
      period: string,
      limit: number,
      viewMode: ViewMode,
    ): Promise<IndustryTreeMap> => {
      const cacheKey = CACHE_KEYS.industryTreeMap(
        period,
        limit,
        viewMode.toString(),
      );

      return getOrSetCached(
        cacheKey,
        async () => {
          const apiPeriod = formatPeriodForAPI(period);
          const edgeResponse = await fetchEdgeReadJson<IndustryTreeMap>(
            "/edge/v1/industry-treemap",
            {
              period: apiPeriod,
              limit,
              viewMode,
            },
          );
          if (edgeResponse) return edgeResponse;

          const transport = createConnectTransport({
            fetch: isrTreeMapFetch,
            baseUrl: SHORTS_API_URL,
          });
          const client = createClient(MarketService, transport);

          const response = await client.getIndustryTreeMap({
            period: apiPeriod,
            limit,
            viewMode,
          });

          return response;
        },
        Number(HOMEPAGE_TTL),
      );
    },
  ),
);
