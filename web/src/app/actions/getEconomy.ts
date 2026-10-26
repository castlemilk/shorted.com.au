import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import { unstable_cache } from "next/cache";
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
// succeeds, KV holds last-good for ECONOMY_TTL regardless of fetch health.
const isrEconomyFetch: typeof fetch = (input, init) =>
  serverFetchWithUserAgent(input, { ...init, next: { revalidate: 3600 } });

function createEconomyClient() {
  const transport = createConnectTransport({
    fetch: isrEconomyFetch,
    baseUrl: SERVER_SHORTS_API_URL,
  });
  return createClient(EconomyService, transport);
}

/**
 * The KV last-good entry for one series request, or undefined.
 *
 * AN EMPTY ENTRY IS A MISS, NOT A HIT (getPoliticians.ts readCached):
 * `fromJson` parses `{}` into a valid response with no series, and serving it
 * would pin the empty state for the whole TTL. A parse failure means the proto
 * changed since the entry was written, which is a miss too.
 */
async function readLastGoodSeries(
  cacheKey: string,
): Promise<GetEconomicSeriesResponse | undefined> {
  const cached = await getCached<JsonValue>(cacheKey);
  if (cached == null) return undefined;
  try {
    const parsed = fromJson(GetEconomicSeriesResponseSchema, cached);
    return parsed.series.length > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Observations for up to 50 economic series keys: the newest
 * `maxObservations` of each, or the API's default history when 0.
 *
 * The live read comes first, and its fetch is ISR-tagged, so the Next data
 * cache answers it while its entry is fresh. KV (Upstash) is the last-good
 * fallback, read only when that read fails or comes back empty. It used to be
 * read first, which cost every regeneration an Upstash round trip whether or
 * not the data cache could answer.
 */
export const getEconomicSeries = cache(
  withRetryAndNotFound(
    async (
      seriesKeys: string[],
      // Annotated for withRetryAndNotFound's TArgs inference (getPoliticians.ts).
      maxObservations: number = 0, // eslint-disable-line @typescript-eslint/no-inferrable-types
    ): Promise<GetEconomicSeriesResponse | undefined> => {
      // Build phase: skip the live fetch so a prerendered /economy route
      // doesn't make a live API call at `next build` time — ISR fills it on
      // first request. Mirrors getHousingOverview in getHousing.ts.
      if (skipForBuild()) return undefined;

      // Keyed on the sorted key list, so logically-equal requests share one
      // entry, and on the observation cap, so a latest-only entry is never
      // served to a caller that asked for history.
      const sortedKeys = [...seriesKeys].sort().join(",");
      const cacheKey = CACHE_KEYS.economicSeries(
        maxObservations > 0 ? `${sortedKeys}@${maxObservations}` : sortedKeys,
      );

      let resp: GetEconomicSeriesResponse;
      try {
        resp = await createEconomyClient().getEconomicSeries({
          seriesKeys,
          maxObservations,
        });
      } catch (error) {
        // A transient RPC failure during an ISR regen must not bake the
        // empty-state placeholder for an hour: serve last-good when there is
        // one. With nothing to fall back to, rethrow so withRetryAndNotFound
        // gets its retries.
        const lastGood = await readLastGoodSeries(cacheKey);
        if (lastGood) return lastGood;
        throw error;
      }

      // Never cache an EMPTY response — a transient empty would pin the
      // placeholder for the full TTL — and prefer last-good over it.
      if (resp.series.length === 0) {
        return (await readLastGoodSeries(cacheKey)) ?? resp;
      }

      // Write-through: every populated live read refreshes last-good. Cache
      // the JSON projection (the proto carries int64 Timestamps that
      // JSON.stringify can't serialize); readLastGoodSeries rehydrates it via
      // fromJson so observation periods keep their BigInt seconds.
      try {
        void setCached(
          cacheKey,
          toJson(GetEconomicSeriesResponseSchema, resp),
          ECONOMY_TTL,
        );
      } catch {
        // Serialization/caching must never break the request.
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

const STATE_EXPOSURE_SLUGS = [
  "nsw",
  "vic",
  "qld",
  "sa",
  "wa",
  "tas",
  "nt",
  "act",
] as const;

export interface StateExposure {
  state: (typeof STATE_EXPOSURE_SLUGS)[number];
  weight: number;
  basis: string;
  source: string;
}

type StateCompaniesLoader = (
  state: string,
  limit: number,
) => Promise<ListStateCompaniesResponse | undefined>;

/** Build the stock-code reverse lookup while isolating per-state failures. */
export async function buildStateExposureIndex(
  loader: StateCompaniesLoader = listStateCompanies,
): Promise<Record<string, StateExposure[]>> {
  const stateResults = await Promise.all(
    STATE_EXPOSURE_SLUGS.map(async (state) => {
      // V1 only reads each state's top 50 by weight. A company outside that
      // state-specific top 50 will not appear in the reverse index.
      const response = await loader(state, 50).catch(() => undefined);
      return [state, response?.companies ?? []] as const;
    }),
  );

  const index: Record<string, StateExposure[]> = {};
  for (const [state, companies] of stateResults) {
    for (const company of companies) {
      const stockCode = company.stockCode.trim().toUpperCase();
      if (!stockCode) continue;
      (index[stockCode] ??= []).push({
        state,
        weight: company.weight,
        basis: company.basis,
        source: company.source,
      });
    }
  }
  return index;
}

/** Operations-weighted state exposure rows, indexed by uppercase ASX code. */
export async function getStateExposureIndex(): Promise<
  Record<string, StateExposure[]>
> {
  if (skipForBuild()) return {};

  try {
    return await unstable_cache(
      async () => {
        const index = await buildStateExposureIndex();
        // Throw inside the cache callback so a transient all-empty response is
        // never persisted for the full daily cache window.
        if (Object.keys(index).length === 0) {
          throw new Error("state exposure index returned no companies");
        }
        return index;
      },
      ["economy-state-exposure-index-v1"],
      { tags: ["economy-state-companies"], revalidate: 86400 },
    )();
  } catch (error) {
    console.error("[getStateExposureIndex] failed:", error);
    return {};
  }
}
