import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import {
  ShortedStocksService,
  GetHousingOverviewResponseSchema,
  type GetHousingOverviewResponse,
  type GetHousePriceSeriesResponse,
  type ListStateSuburbsResponse,
  type GetSuburbProfileResponse,
  type ListSuburbPriceDropsResponse,
  type ListSuburbDropListingsResponse,
  type GetPriceDropsOverviewResponse,
  type ListAgencyPriceStatsResponse,
} from "~/gen/shorts/v1alpha1/shorts_pb";
import { cache } from "react";
import {
  SERVER_SHORTS_API_URL,
  serverFetchWithUserAgent,
  skipForBuild,
} from "./config";
import { CACHE_KEYS, HOUSING_TTL, getCached, setCached } from "@/lib/kv-cache";
import { withRetryAndNotFound } from "./withRetry";
import { suburbSlug } from "@/lib/housing/states";

function createHousingClient() {
  const transport = createConnectTransport({
    fetch: serverFetchWithUserAgent,
    baseUrl: SERVER_SHORTS_API_URL,
  });
  return createClient(ShortedStocksService, transport);
}

// A transport whose fetch tags the request ISR-cacheable. Without a `next`
// (or explicit `cache`) option, serverFetchWithUserAgent forces `cache:'no-store'`
// on POSTs at Vercel runtime, which opts the whole route out of static
// generation — so /housing paid a blocking Cloud Run round-trip on EVERY
// visitor's TTFB despite `export const revalidate = 3600`. Tagging the fetch
// revalidate-cacheable lets /housing render as static ISR (the sanctioned
// pattern from getIndustryData / fetchTreeMap3m). Scoped to getHousingOverview
// only — the suburb/state routes (listStateSuburbs/getSuburbProfile) keep the
// default transport and their own generateStaticParams setup.
const isrHousingFetch: typeof fetch = (input, init) =>
  serverFetchWithUserAgent(input, { ...init, next: { revalidate: 3600 } });

function createCacheableHousingClient() {
  const transport = createConnectTransport({
    fetch: isrHousingFetch,
    baseUrl: SERVER_SHORTS_API_URL,
  });
  return createClient(ShortedStocksService, transport);
}

/** Latest house-price headline metrics per region (optionally filtered by type). */
export const getHousingOverview = cache(
  withRetryAndNotFound(
    async (
      regionType: string = "", // eslint-disable-line @typescript-eslint/no-inferrable-types
    ): Promise<GetHousingOverviewResponse | undefined> => {
      // Build phase: skip the live fetch so the now-static /housing route
      // prerenders its (transient) empty state under SKIP_STATIC_GENERATION
      // instead of hitting the API — ISR fills it on first request. The page
      // already handles undefined (`overview?.metrics ?? []`).
      if (skipForBuild()) return undefined;

      // KV cache (Upstash, TTL-only): flips the still-dynamic /housing/calculators
      // (and /housing ISR regen) from a full Cloud Run RPC to a ~5-30ms cache
      // GET. Cache the JSON projection — Upstash's JSON.stringify throws on the
      // proto's int64 asOf field — and fromJson-rehydrate on read so consumers
      // that read `asOf.seconds` (BigInt) keep working (protobuf-es toJson trap).
      const cacheKey = CACHE_KEYS.housingOverview(regionType);
      const cached = await getCached<JsonValue>(cacheKey);
      if (cached != null) {
        try {
          return fromJson(GetHousingOverviewResponseSchema, cached);
        } catch {
          // Deserialize mismatch (schema drift / bad entry) — fall through to a
          // live fetch rather than surfacing a broken page.
        }
      }

      const client = createCacheableHousingClient();
      const resp = await client.getHousingOverview({ regionType });
      // Never cache an EMPTY response. A transient empty (e.g. the backend
      // mid-redeploy, or an MV refresh window) would otherwise pin /housing to
      // its empty state for the full HOUSING_TTL (24h) with no flush path —
      // exactly the outage this guards against. Only cache real metrics.
      if (resp.metrics.length > 0) {
        try {
          void setCached(
            cacheKey,
            toJson(GetHousingOverviewResponseSchema, resp),
            HOUSING_TTL,
          );
        } catch {
          // Serialization/caching must never break the request.
        }
      }
      return resp;
    },
  ),
);

/** A single house-price time series for a region × measure (× dwelling type). */
export const getHousePriceSeries = cache(
  withRetryAndNotFound(
    async (
      regionCode: string,
      measure: string,
      dwellingType: string = "", // eslint-disable-line @typescript-eslint/no-inferrable-types
    ): Promise<GetHousePriceSeriesResponse> => {
      const client = createHousingClient();
      return client.getHousePriceSeries({ regionCode, measure, dwellingType });
    },
  ),
);

/** Every suburb in a state with price + headline demographics. */
export const listStateSuburbs = cache(
  withRetryAndNotFound(
    async (stateCode: string, query: string = "", limit: number = 5000): Promise<ListStateSuburbsResponse> => { // eslint-disable-line @typescript-eslint/no-inferrable-types
      const client = createHousingClient();
      return client.listStateSuburbs({ stateCode, query, limit });
    },
  ),
);

/** Full per-suburb profile by ABS SAL code. */
export const getSuburbProfile = cache(
  withRetryAndNotFound(
    async (salCode: string): Promise<GetSuburbProfileResponse> => {
      const client = createHousingClient();
      return client.getSuburbProfile({ salCode });
    },
  ),
);

/** Suburbs ranked by recent for-sale asking-price drops (derived aggregate). */
export const listSuburbPriceDrops = cache(
  withRetryAndNotFound(
    async (stateCode: string = "", sort: string = "count", limit: number = 50): Promise<ListSuburbPriceDropsResponse> => { // eslint-disable-line @typescript-eslint/no-inferrable-types
      const client = createHousingClient();
      return client.listSuburbPriceDrops({ stateCode, sort, limit });
    },
  ),
);

/** Per-suburb recently-reduced listings (deep-links out; flag-gated server-side). */
export const listSuburbDropListings = cache(
  withRetryAndNotFound(
    async (salCode: string = "", regionCode: string = "", windowDays: number = 30, limit: number = 30): Promise<ListSuburbDropListingsResponse> => { // eslint-disable-line @typescript-eslint/no-inferrable-types
      const client = createHousingClient();
      return client.listSuburbDropListings({ salCode, regionCode, windowDays, limit });
    },
  ),
);

/** Per-state price-drop + asking/sold rollup with an AU national row (derived aggregate). */
export const getPriceDropsOverview = cache(
  withRetryAndNotFound(
    async (): Promise<GetPriceDropsOverviewResponse> => {
      const client = createHousingClient();
      return client.getPriceDropsOverview({});
    },
  ),
);

/** Agencies ranked by recent asking-price cuts (derived aggregate). */
export const listAgencyPriceStats = cache(
  withRetryAndNotFound(
    async (stateCode: string = "", sort: string = "drops", limit: number = 20): Promise<ListAgencyPriceStatsResponse> => { // eslint-disable-line @typescript-eslint/no-inferrable-types
      const client = createHousingClient();
      return client.listAgencyPriceStats({ stateCode, sort, limit });
    },
  ),
);

/**
 * Resolve a suburb's SAL code from its URL slug + state — lets the clean
 * /housing/[state]/[suburb] URL render WITHOUT the ?sal= fast-path (so the
 * canonical we advertise to crawlers actually resolves). Cached per (state,slug).
 */
export const resolveSuburbSalCode = cache(
  async (stateCode: string, slug: string): Promise<string | null> => {
    const res = await listStateSuburbs(stateCode, "", 5000).catch(() => null);
    const match = res?.suburbs.find((s) => suburbSlug(s.salName, s.postcode) === slug);
    return match?.salCode ?? null;
  },
);
