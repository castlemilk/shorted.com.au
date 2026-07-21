import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import {
  ShortedStocksService,
  type GetEconomicSeriesResponse,
  type ListEconomicSeriesResponse,
} from "~/gen/shorts/v1alpha1/shorts_pb";
import { cache } from "react";
import {
  SERVER_SHORTS_API_URL,
  serverFetchWithUserAgent,
  skipForBuild,
} from "./config";
import { withRetryAndNotFound } from "./withRetry";

// A transport whose fetch tags the request ISR-cacheable — mirrors
// isrHousingFetch in getHousing.ts. Without a `next` (or explicit `cache`)
// option, serverFetchWithUserAgent forces `cache:'no-store'` on POSTs at
// Vercel runtime, which opts the whole route out of static generation.
const isrEconomyFetch: typeof fetch = (input, init) =>
  serverFetchWithUserAgent(input, { ...init, next: { revalidate: 3600 } });

function createCacheableEconomyClient() {
  const transport = createConnectTransport({
    fetch: isrEconomyFetch,
    baseUrl: SERVER_SHORTS_API_URL,
  });
  return createClient(ShortedStocksService, transport);
}

/** Observations for up to 50 economic series keys. */
export const getEconomicSeries = cache(
  withRetryAndNotFound(
    async (
      seriesKeys: string[],
    ): Promise<GetEconomicSeriesResponse | undefined> => {
      // Build phase: skip the live fetch so a prerendered /economy route
      // doesn't make a live API call at `next build` time — ISR fills it on
      // first request. Mirrors getHousingOverview in getHousing.ts.
      if (skipForBuild()) return undefined;

      const client = createCacheableEconomyClient();
      return client.getEconomicSeries({ seriesKeys });
    },
  ),
);

/** Catalog of available economic series, optionally filtered. */
export const listEconomicSeries = cache(
  withRetryAndNotFound(
    async (
      topic: string = "", // eslint-disable-line @typescript-eslint/no-inferrable-types
      metric: string = "", // eslint-disable-line @typescript-eslint/no-inferrable-types
      regionType: string = "", // eslint-disable-line @typescript-eslint/no-inferrable-types
    ): Promise<ListEconomicSeriesResponse | undefined> => {
      if (skipForBuild()) return undefined;

      const client = createCacheableEconomyClient();
      return client.listEconomicSeries({ topic, metric, regionType, limit: 500 });
    },
  ),
);
