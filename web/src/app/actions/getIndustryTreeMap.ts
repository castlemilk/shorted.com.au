import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";
import { type IndustryTreeMap } from "~/gen/stocks/v1alpha1/stocks_pb";
import { type ViewMode } from "~/gen/shorts/v1alpha1/shorts_pb";
import { SHORTS_API_URL } from "./config";
import { formatPeriodForAPI } from "~/lib/period-utils";
import { cache } from "react";
import { getOrSetCached, CACHE_KEYS, HOMEPAGE_TTL } from "~/@/lib/kv-cache";
import { withRetry } from "./withRetry";

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
          const transport = createConnectTransport({
            baseUrl:
              process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT ?? SHORTS_API_URL,
          });
          const client = createClient(ShortedStocksService, transport);

          const response = await client.getIndustryTreeMap({
            period: formatPeriodForAPI(period),
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
