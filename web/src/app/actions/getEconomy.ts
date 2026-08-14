import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import { GetEconomicSeriesResponseSchema, type GetEconomicSeriesResponse, type GetStateCompanyAggregatesResponse, type ListEconomicSeriesResponse, type ListStateCompaniesResponse } from "~/gen/shorts/v1alpha1/economy_pb";
import { EconomyService } from "~/gen/shorts/v1alpha1/economy_pb";
import { cache } from "react";
import {
  SERVER_SHORTS_API_URL,
  serverFetchWithUserAgent,
  skipForBuild,
} from "./config";
import { withRetryAndNotFound } from "./withRetry";
import { CACHE_KEYS, ECONOMY_TTL, getCached, setCached } from "@/lib/kv-cache";

// ISR-tagged transport (housing's isrHousingFetch pattern) — the `next:
// { revalidate }` tag is LOAD-BEARING inside static routes: without it,
// serverFetchWithUserAgent forces `cache:'no-store'` on POSTs, and a no-store
// fetch inside an ISR page THROWS "Page changed from static to dynamic at
// runtime" (observed live on /economy, 2026-07-22) — withRetryAndNotFound
// then returns undefined and the placeholder gets baked for an hour. The KV
// layer below is the resilience mechanism for any residual fetch failure
// (e.g. the sitemap.ts "Failed to generate cache key" mode): once one regen
// succeeds, KV serves last-good for ECONOMY_TTL regardless of fetch health.
const isrEconomyFetch: typeof fetch = (input, init) =>
  serverFetchWithUserAgent(input, { ...init, next: { revalidate: 3600 } });

function createEconomyClient() {
  const transport = createConnectTransport({
    fetch: isrEconomyFetch,
    baseUrl: SERVER_SHORTS_API_URL,
  });
  return createClient(EconomyService, transport);
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

      // KV cache (Upstash, TTL-only) — the last-good fallback that stops a
      // transient RPC failure during ISR regen from baking the empty-state
      // placeholder for an hour. Cache the JSON projection (the proto carries
      // int64 Timestamps that JSON.stringify can't serialize) and rehydrate
      // via fromJson so observation periods keep their BigInt seconds.
      const cacheKey = CACHE_KEYS.economicSeries(
        [...seriesKeys].sort().join(","),
      );
      const cached = await getCached<JsonValue>(cacheKey);
      if (cached != null) {
        try {
          return fromJson(GetEconomicSeriesResponseSchema, cached);
        } catch {
          // Schema drift / bad entry — fall through to a live fetch.
        }
      }

      const client = createEconomyClient();
      const resp = await client.getEconomicSeries({ seriesKeys });
      // Never cache an EMPTY response — a transient empty would pin the
      // placeholder for the full TTL. Only cache real series.
      if (resp.series.length > 0) {
        try {
          void setCached(
            cacheKey,
            toJson(GetEconomicSeriesResponseSchema, resp),
            ECONOMY_TTL,
          );
        } catch {
          // Serialization/caching must never break the request.
        }
      }
      return resp;
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

      const client = createEconomyClient();
      return client.listEconomicSeries({ topic, metric, regionType, limit: 500 });
    },
  ),
);

/** Per-state company-exposure aggregates (all states in one response). */
export const getStateCompanyAggregates = cache(
  withRetryAndNotFound(
    async (): Promise<GetStateCompanyAggregatesResponse | undefined> => {
      if (skipForBuild()) return undefined;

      const client = createEconomyClient();
      return client.getStateCompanyAggregates({});
    },
  ),
);

/** Top companies operating in a state (weight-desc, dossier "Operating here"). */
export const listStateCompanies = cache(
  withRetryAndNotFound(
    async (
      state: string,
      limit: number = 8, // eslint-disable-line @typescript-eslint/no-inferrable-types
    ): Promise<ListStateCompaniesResponse | undefined> => {
      if (skipForBuild()) return undefined;

      const client = createEconomyClient();
      return client.listStateCompanies({ state, limit });
    },
  ),
);
