import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { create, fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import { GetDropIndexSeriesResponseSchema, GetHousingOverviewResponseSchema, GetPriceDropsOverviewResponseSchema, ListSuburbPriceDropsResponseSchema, type GetHousingOverviewResponse, type GetHousePriceSeriesResponse, type ListStateSuburbsResponse, type GetSuburbProfileResponse, type ListSuburbPriceDropsResponse, type ListSuburbDropListingsResponse, type GetPriceDropsOverviewResponse, type ListAgencyPriceStatsResponse, type ListAddressPriceDropsResponse, type GetDropIndexSeriesResponse } from "~/gen/shorts/v1alpha1/housing_pb";
import { HousingService } from "~/gen/shorts/v1alpha1/housing_pb";
import { cache } from "react";
import {
  SERVER_SHORTS_API_URL,
  serverFetchWithUserAgent,
  skipForBuild,
} from "./config";
import {
  CACHE_KEYS,
  HOUSING_TTL,
  PRICE_DROPS_TTL,
  getCached,
  setCached,
} from "@/lib/kv-cache";
import { withRetryAndNotFound, withRetryAndThrowNotFound } from "./withRetry";
import { suburbSlug } from "@/lib/housing/states";

function createHousingClient() {
  const transport = createConnectTransport({
    fetch: serverFetchWithUserAgent,
    baseUrl: SERVER_SHORTS_API_URL,
  });
  return createClient(HousingService, transport);
}

// A transport whose fetch tags the request ISR-cacheable. Without a `next`
// (or explicit `cache`) option, serverFetchWithUserAgent forces `cache:'no-store'`
// on POSTs at Vercel runtime, which opts the whole route out of static
// generation — so /housing paid a blocking Cloud Run round-trip on EVERY
// visitor's TTFB despite `export const revalidate = 3600`. Tagging the fetch
// revalidate-cacheable lets /housing render as static ISR (the sanctioned
// pattern from getIndustryData / fetchTreeMap3m). Scoped to getHousingOverview
// only — suburb profile routes use their separate daily on-demand ISR transport
// below, while other housing actions retain the default transport.
const isrHousingFetch: typeof fetch = (input, init) =>
  serverFetchWithUserAgent(input, { ...init, next: { revalidate: 3600 } });

// The on-demand ISR suburb route regenerates daily. This metadata is an ISR
// guard: without it serverFetchWithUserAgent marks Connect POSTs `no-store` and
// opts the route into dynamic rendering. Next cannot fetch-cache Connect's
// Uint8Array request bodies, so callers must still keep response payloads small.
const suburbIsrFetch: typeof fetch = (input, init) =>
  serverFetchWithUserAgent(input, { ...init, next: { revalidate: 86400 } });

function createCacheableHousingClient() {
  const transport = createConnectTransport({
    fetch: isrHousingFetch,
    baseUrl: SERVER_SHORTS_API_URL,
  });
  return createClient(HousingService, transport);
}

function createSuburbIsrHousingClient() {
  const transport = createConnectTransport({
    fetch: suburbIsrFetch,
    baseUrl: SERVER_SHORTS_API_URL,
  });
  return createClient(HousingService, transport);
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
      const client = createSuburbIsrHousingClient();
      return client.listStateSuburbs({ stateCode, query, limit });
    },
  ),
);

/** Full per-suburb profile by ABS SAL code. */
export const getSuburbProfile = cache(
  withRetryAndThrowNotFound(
    async (salCode: string): Promise<GetSuburbProfileResponse> => {
      const client = createSuburbIsrHousingClient();
      return client.getSuburbProfile({ salCode });
    },
  ),
);

// The /price-drops board is static ISR (data changes ~once/day after the crawl).
// Its anonymous aggregate actions get the same treatment as getHousingOverview:
// skipForBuild() during the prerender, an Upstash KV layer keyed under
// cache:housing:drops: (busted on the crawl event via
// /api/revalidate?flush=housing), and the ISR-cacheable transport — WITHOUT the
// `next:{revalidate}` tag serverFetchWithUserAgent forces cache:'no-store' on the
// POST and silently opts the whole route back into dynamic rendering. Flag-gated
// agency/address reads retain the ISR-cacheable transport but bypass shared KV.

/** Suburbs ranked by recent for-sale asking-price drops (derived aggregate). */
export const listSuburbPriceDrops = cache(
  withRetryAndNotFound(
    async (stateCode: string = "", sort: string = "count", limit: number = 50): Promise<ListSuburbPriceDropsResponse | undefined> => { // eslint-disable-line @typescript-eslint/no-inferrable-types
      if (skipForBuild()) return undefined;

      const cacheKey = CACHE_KEYS.suburbPriceDrops(stateCode, sort, limit);
      const cached = await getCached<JsonValue>(cacheKey);
      if (cached != null) {
        try {
          return fromJson(ListSuburbPriceDropsResponseSchema, cached);
        } catch {
          // Schema drift / bad entry — fall through to a live fetch.
        }
      }

      const client = createCacheableHousingClient();
      const resp = await client.listSuburbPriceDrops({ stateCode, sort, limit });
      // Never cache an EMPTY response (same guard as getHousingOverview): a
      // transient empty during a backend redeploy would otherwise pin the board
      // until the next crawl flush or the 24h TTL.
      if (resp.suburbs.length > 0) {
        try {
          void setCached(cacheKey, toJson(ListSuburbPriceDropsResponseSchema, resp), PRICE_DROPS_TTL);
        } catch {
          // Serialization/caching must never break the request.
        }
      }
      return resp;
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
    async (): Promise<GetPriceDropsOverviewResponse | undefined> => {
      if (skipForBuild()) return undefined;

      const cacheKey = CACHE_KEYS.priceDropsOverview();
      const cached = await getCached<JsonValue>(cacheKey);
      if (cached != null) {
        try {
          return fromJson(GetPriceDropsOverviewResponseSchema, cached);
        } catch {
          // Schema drift / bad entry — fall through to a live fetch.
        }
      }

      const client = createCacheableHousingClient();
      const resp = await client.getPriceDropsOverview({});
      // Never cache an EMPTY response (same guard as getHousingOverview).
      if (resp.national != null || resp.states.length > 0) {
        try {
          void setCached(cacheKey, toJson(GetPriceDropsOverviewResponseSchema, resp), PRICE_DROPS_TTL);
        } catch {
          // Serialization/caching must never break the request.
        }
      }
      return resp;
    },
  ),
);

/**
 * Agencies ranked by recent asking-price cuts. This flag-gated surface carries
 * agency/agent names, so it deliberately bypasses the shared 24h KV layer. The
 * takedown runbook's revalidation clears ISR/Data Cache so subsequent renders
 * reach the backend kill switch instead of replaying pre-takedown data.
 */
export const listAgencyPriceStats = cache(
  withRetryAndNotFound(
    async (stateCode: string = "", sort: string = "drops", limit: number = 20): Promise<ListAgencyPriceStatsResponse | undefined> => { // eslint-disable-line @typescript-eslint/no-inferrable-types
      if (skipForBuild()) return undefined;

      const client = createCacheableHousingClient();
      return client.listAgencyPriceStats({ stateCode, sort, limit });
    },
  ),
);

/**
 * Individual addresses ranked by asking-price drop — the /price-drops address
 * board's default (all-states, biggest-%) view, fetched server-side to seed the
 * client board without a first-paint round-trip. Like the agency read, it
 * bypasses shared KV; the takedown revalidation clears ISR/Data Cache so later
 * renders consult the backend kill switch.
 */
export const listAddressPriceDrops = cache(
  withRetryAndNotFound(
    async (stateCode: string = "", windowDays: number = 90, limit: number = 50, sort: string = "pct"): Promise<ListAddressPriceDropsResponse | undefined> => { // eslint-disable-line @typescript-eslint/no-inferrable-types
      if (skipForBuild()) return undefined;

      const client = createCacheableHousingClient();
      return client.listAddressPriceDrops({ stateCode, windowDays, limit, sort });
    },
  ),
);

/**
 * The equal-weighted discounting index (drop rate over time) behind the
 * /price-drops headline chart. Static ISR like the other aggregate reads
 * above — WITHOUT the `next:{revalidate}` tag on the transport, the POST
 * defaults to no-store and silently forces the whole route dynamic. Gap days
 * (crawl outage 2026-08-13..15) are still included on the wire; the client
 * component is responsible for excluding isGap points before plotting.
 */
const emptyDropIndexSeries = (): GetDropIndexSeriesResponse =>
  create(GetDropIndexSeriesResponseSchema, { points: [], trackingSince: "" });

const getDropIndexSeriesOrUndefined = cache(
  withRetryAndNotFound(
    async (
      grain: string = "national", // eslint-disable-line @typescript-eslint/no-inferrable-types
      grainKey: string = "AU", // eslint-disable-line @typescript-eslint/no-inferrable-types
    ): Promise<GetDropIndexSeriesResponse> => {
      if (skipForBuild()) return emptyDropIndexSeries();

      const client = createCacheableHousingClient();
      return client.getDropIndexSeries({ grain, grainKey, from: "", to: "" });
    },
  ),
);

/**
 * @param grain 'national' | 'state' | 'suburb'
 * @param grainKey 'AU' | state code | sal_code
 */
export async function getDropIndexSeries(
  grain: string = "national", // eslint-disable-line @typescript-eslint/no-inferrable-types
  grainKey: string = "AU", // eslint-disable-line @typescript-eslint/no-inferrable-types
): Promise<GetDropIndexSeriesResponse> {
  const resp = await getDropIndexSeriesOrUndefined(grain, grainKey);
  return resp ?? emptyDropIndexSeries();
}

/**
 * Resolve a suburb's SAL code from its URL slug + state — lets the clean
 * /housing/[state]/[suburb] URL render WITHOUT the ?sal= fast-path (so the
 * canonical we advertise to crawlers actually resolves). Cached per (state,slug).
 */
export const resolveSuburbSalCode = cache(
  async (stateCode: string, slug: string): Promise<string | null> => {
    // Strip the canonical postcode and optional ABS state qualifier before
    // searching. This keeps the resolver response to a handful of rows instead
    // of downloading the state's multi-megabyte suburb index on every ISR.
    const normalizedSlug = slug
      .replace(/-+$/, "")
      .replace(/-\d{4}$/, "")
      .replace(new RegExp(`-${stateCode.toLowerCase()}$`), "");
    const query = normalizedSlug.replace(/-/g, " ");
    let res = await listStateSuburbs(stateCode, query, 50);
    if (!res) {
      throw new Error(`Unable to resolve suburb slug while ${stateCode} suburb data is unavailable`);
    }
    const canonicalSlug = slug.replace(/-+$/, "");
    let match = res.suburbs.find((s) => suburbSlug(s.salName, s.postcode) === canonicalSlug);

    // Names containing punctuation (for example O'Connor) do not match their
    // space-normalised slug through ILIKE. Retry with the final word, still a
    // bounded query, and verify the full canonical slug locally.
    const fallbackQuery = normalizedSlug.split("-").at(-1) ?? query;
    if (!match && fallbackQuery !== query) {
      res = await listStateSuburbs(stateCode, fallbackQuery, 50);
      if (!res) {
        throw new Error(`Unable to resolve suburb slug while ${stateCode} suburb data is unavailable`);
      }
      match = res.suburbs.find((s) => suburbSlug(s.salName, s.postcode) === canonicalSlug);
    }
    return match?.salCode ?? null;
  },
);
