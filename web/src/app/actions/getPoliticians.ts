import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import {
  PoliticiansService,
  GetParliamentOverviewResponseSchema,
  ListPoliticiansResponseSchema,
  GetPoliticianResponseSchema,
  ListStockPoliticiansResponseSchema,
  ListPoliticianStocksResponseSchema,
  ListSuburbPoliticiansResponseSchema,
  ListStatePoliticianHoldingsResponseSchema,
  ListRegisterChangesResponseSchema,
  ListShortInterestOverlapResponseSchema,
  GetPoliticianAnalyticsResponseSchema,
  GetRegisterExplorerResponseSchema,
  ListPoliticianSummariesResponseSchema,
  PoliticianSummarySort,
  type GetParliamentOverviewResponse,
  type ListPoliticiansResponse,
  type GetPoliticianResponse,
  type ListStockPoliticiansResponse,
  type ListPoliticianStocksResponse,
  type ListSuburbPoliticiansResponse,
  type ListStatePoliticianHoldingsResponse,
  type ListRegisterChangesResponse,
  type ListShortInterestOverlapResponse,
  type GetPoliticianAnalyticsResponse,
  type GetRegisterExplorerResponse,
  type ListPoliticianSummariesResponse,
} from "~/gen/shorts/v1alpha1/politicians_pb";
import { cache } from "react";
import {
  SERVER_SHORTS_API_URL,
  serverFetchWithUserAgent,
  skipForBuild,
} from "./config";
import { CACHE_KEYS, POLITICIANS_TTL, getCached, setCached } from "@/lib/kv-cache";
import { withRetryAndNotFound } from "./withRetry";

// A transport whose fetch tags the request ISR-cacheable.
//
// LOAD-BEARING. Without a `next` (or explicit `cache`) option,
// serverFetchWithUserAgent forces `cache:'no-store'` on POSTs at Vercel runtime,
// which opts the whole route out of static generation — and worse, throws
// "Page changed from static to dynamic at runtime" during an ISR regen, baking
// the placeholder for an hour. Same lesson as getHousing/getEconomy.
const isrPoliticiansFetch: typeof fetch = (input, init) =>
  serverFetchWithUserAgent(input, { ...init, next: { revalidate: 3600 } });

function createCacheablePoliticiansClient() {
  const transport = createConnectTransport({
    fetch: isrPoliticiansFetch,
    baseUrl: SERVER_SHORTS_API_URL,
  });
  return createClient(PoliticiansService, transport);
}

/**
 * Read a cached response, tolerating schema drift.
 *
 * A `fromJson` failure means the proto changed since the entry was written; we
 * fall through to a live fetch rather than serving a broken shape.
 */
function readCached<T>(
  schema: Parameters<typeof fromJson>[0],
  cached: JsonValue | null,
  /**
   * Non-emptiness test. AN EMPTY CACHE ENTRY IS A MISS, NOT A HIT.
   *
   * Every writer here already refuses to cache an empty response — "NEVER cache
   * an empty response: the kill switch and a cold MV both return {}". The READ
   * path had no matching guard, and the asymmetry is what makes a bad entry
   * STICK: `fromJson` parses `{}` into a perfectly valid message whose counts
   * are all zero, `if (hit)` is truthy for any object, and the function returns
   * before it ever reaches the fetch that would have corrected it. The entry
   * then serves zeros for the full 24h TTL and the write guard can never fire.
   *
   * That is exactly what /politicians served after the 2026-07-31 deploy: the
   * API was healthy on every route, and the page still showed 0
   * parliamentarians / 0 declared entries until the cache was flushed by hand.
   *
   * With this, a zeroed entry degrades to a cache miss and the next request
   * self-heals.
   */
  isPopulated: (value: T) => boolean,
): T | undefined {
  if (cached == null) return undefined;
  try {
    const parsed = fromJson(schema, cached) as T;
    return isPopulated(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write a cache entry, fire-and-forget.
 *
 * Caches the toJson PROJECTION, never the proto: register messages carry
 * Timestamps, which are BigInt-backed and make JSON.stringify throw.
 */
function writeCached(schema: Parameters<typeof toJson>[0], key: string, value: unknown): void {
  try {
    void setCached(key, toJson(schema, value as never) as JsonValue, POLITICIANS_TTL);
  } catch {
    // Never let a cache write break a render.
  }
}

/** Parliament-wide counts and the as-at date. */
export const getParliamentOverview = cache(
  withRetryAndNotFound(async (): Promise<GetParliamentOverviewResponse | undefined> => {
    if (skipForBuild()) return undefined;
    const key = CACHE_KEYS.parliamentOverview();
    const hit = readCached<GetParliamentOverviewResponse>(
      GetParliamentOverviewResponseSchema,
      await getCached<JsonValue>(key),
      (v) => v.politicianCount > 0,
    );
    if (hit) return hit;

    const resp = await createCacheablePoliticiansClient().getParliamentOverview({});
    // NEVER cache an empty response: the kill switch and a cold MV both return
    // {}, and caching that pins the empty state for 24h.
    if (resp.politicianCount > 0) {
      writeCached(GetParliamentOverviewResponseSchema, key, resp);
    }
    return resp;
  }),
);

/** Browse/filter parliamentarians. */
export const listPoliticians = cache(
  withRetryAndNotFound(
    async (
      // Types are annotated even where a default would infer them: these
      // functions are contextual arguments to withRetryAndNotFound's
      // `TArgs extends unknown[]`, and inference falls back to the constraint
      // (every parameter becomes `unknown`) unless the annotation is explicit.
      // Same reason and same eslint-disable as getHousing.ts.
      chamber: string = "", // eslint-disable-line @typescript-eslint/no-inferrable-types
      stateCode: string = "", // eslint-disable-line @typescript-eslint/no-inferrable-types
      partyAb: string = "", // eslint-disable-line @typescript-eslint/no-inferrable-types
      query: string = "", // eslint-disable-line @typescript-eslint/no-inferrable-types
      limit: number = 100, // eslint-disable-line @typescript-eslint/no-inferrable-types
      offset: number = 0, // eslint-disable-line @typescript-eslint/no-inferrable-types
    ): Promise<ListPoliticiansResponse | undefined> => {
      if (skipForBuild()) return undefined;
      const key = CACHE_KEYS.politicianList(chamber, stateCode, partyAb, query, limit, offset);
      const hit = readCached<ListPoliticiansResponse>(
        ListPoliticiansResponseSchema,
        await getCached<JsonValue>(key),
        (v) => v.politicians.length > 0,
      );
      if (hit) return hit;

      const resp = await createCacheablePoliticiansClient().listPoliticians({
        chamber,
        stateCode,
        partyAb,
        query,
        limit,
        offset,
      });
      if (resp.politicians.length > 0) {
        writeCached(ListPoliticiansResponseSchema, key, resp);
      }
      return resp;
    },
  ),
);

/** One politician's declared interests and history. */
export const getPolitician = cache(
  withRetryAndNotFound(async (slug: string): Promise<GetPoliticianResponse | undefined> => {
    if (!slug) return undefined;
    if (skipForBuild()) return undefined;
    const key = CACHE_KEYS.politicianProfile(slug);
    const hit = readCached<GetPoliticianResponse>(
      GetPoliticianResponseSchema,
      await getCached<JsonValue>(key),
      (v) => !!v.politician,
    );
    if (hit) return hit;

    const resp = await createCacheablePoliticiansClient().getPolitician({ slug });
    if (resp.politician) {
      writeCached(GetPoliticianResponseSchema, key, resp);
    }
    return resp;
  }),
);

/** Parliamentarians declaring an interest in one company. */
export const listStockPoliticians = cache(
  withRetryAndNotFound(
    async (stockCode: string): Promise<ListStockPoliticiansResponse | undefined> => {
      if (!stockCode) return undefined;
      if (skipForBuild()) return undefined;
      const code = stockCode.toUpperCase();
      const key = CACHE_KEYS.stockPoliticians(code);
      const hit = readCached<ListStockPoliticiansResponse>(
        ListStockPoliticiansResponseSchema,
        await getCached<JsonValue>(key),
        (v) => v.interests.length > 0,
      );
      if (hit) return hit;

      const resp = await createCacheablePoliticiansClient().listStockPoliticians({
        stockCode: code,
      });
      if (resp.interests.length > 0) {
        writeCached(ListStockPoliticiansResponseSchema, key, resp);
      }
      return resp;
    },
  ),
);

/** Parliament's most-declared companies. */
export const listPoliticianStocks = cache(
  withRetryAndNotFound(
    async (
      limit: number = 50, // eslint-disable-line @typescript-eslint/no-inferrable-types
      currentOnly: boolean = true, // eslint-disable-line @typescript-eslint/no-inferrable-types
    ): Promise<ListPoliticianStocksResponse | undefined> => {
      if (skipForBuild()) return undefined;
      const key = CACHE_KEYS.politicianStocks(limit, currentOnly);
      const hit = readCached<ListPoliticianStocksResponse>(
        ListPoliticianStocksResponseSchema,
        await getCached<JsonValue>(key),
        (v) => v.stocks.length > 0,
      );
      if (hit) return hit;

      const resp = await createCacheablePoliticiansClient().listPoliticianStocks({
        limit,
        currentOnly,
      });
      if (resp.stocks.length > 0) {
        writeCached(ListPoliticianStocksResponseSchema, key, resp);
      }
      return resp;
    },
  ),
);

/**
 * Aggregate shape of the register — the party x industry matrix and the state
 * split behind the analytics views.
 *
 * Counts of PEOPLE and of COMPANIES only. There is no value in the registers to
 * aggregate, so nothing here can be weighted or sized.
 */
export const getPoliticianAnalytics = cache(
  withRetryAndNotFound(
    async (
      topIndustries: number = 14, // eslint-disable-line @typescript-eslint/no-inferrable-types
      currentOnly: boolean = false, // eslint-disable-line @typescript-eslint/no-inferrable-types
    ): Promise<GetPoliticianAnalyticsResponse | undefined> => {
      if (skipForBuild()) return undefined;
      const key = CACHE_KEYS.politicianAnalytics(topIndustries, currentOnly);
      const hit = readCached<GetPoliticianAnalyticsResponse>(
        GetPoliticianAnalyticsResponseSchema,
        await getCached<JsonValue>(key),
        (v) => v.cells.length > 0,
      );
      if (hit) return hit;

      const resp = await createCacheablePoliticiansClient().getPoliticianAnalytics({
        topIndustries,
        currentOnly,
      });
      // NEVER cache an empty response: the kill switch and a cold MV both return
      // {}, and caching that pins the empty state for 24h.
      if (resp.cells.length > 0) {
        writeCached(GetPoliticianAnalyticsResponseSchema, key, resp);
      }
      return resp;
    },
  ),
);

/**
 * The hub explorer aggregates: per-category counts, holder totals, change
 * activity, industry movement and the coverage buckets.
 *
 * Counts only — of ENTRIES and of PEOPLE. There is no amount anywhere in this
 * response to aggregate, and none may be inferred from one.
 */
export const getRegisterExplorer = cache(
  withRetryAndNotFound(async (): Promise<GetRegisterExplorerResponse | undefined> => {
    if (skipForBuild()) return undefined;
    const key = CACHE_KEYS.politicianExplorer();
    const hit = readCached<GetRegisterExplorerResponse>(
      GetRegisterExplorerResponseSchema,
      await getCached<JsonValue>(key),
      // Not `itemCounts.length > 0`: the handler emits a row per register item
      // whether or not anything is declared under it, so a cold MV still parses
      // as fourteen well-formed zeroes. The category TOTALS are what has to be
      // non-empty for this entry to be worth serving.
      (v) => v.itemCounts.some((item) => item.currentCount > 0),
    );
    if (hit) return hit;

    const resp = await createCacheablePoliticiansClient().getRegisterExplorer({});
    // NEVER cache an empty response: the kill switch and a cold MV both return
    // {}, and caching that pins the empty state for 24h. Symmetric with the
    // read guard above, deliberately.
    if (resp.itemCounts.some((item) => item.currentCount > 0)) {
      writeCached(GetRegisterExplorerResponseSchema, key, resp);
    }
    return resp;
  }),
);

/** The sort keys `ListPoliticianSummaries` accepts, mirroring the proto enum. */
export type PoliticianSummarySortKey =
  | "declared_items"
  | "companies"
  | "properties"
  | "recent_changes"
  | "name";

const SUMMARY_SORT_ENUM: Record<PoliticianSummarySortKey, PoliticianSummarySort> = {
  declared_items: PoliticianSummarySort.DECLARED_ITEMS,
  companies: PoliticianSummarySort.COMPANIES,
  properties: PoliticianSummarySort.PROPERTIES,
  recent_changes: PoliticianSummarySort.RECENT_CHANGES,
  name: PoliticianSummarySort.NAME,
};

/** Mirrors `clampLimit(m.Limit, 50, 200)` in politicians_explorer.go. */
export const SUMMARY_LIMIT_DEFAULT = 50;
export const SUMMARY_LIMIT_MAX = 200;

export interface PoliticianSummaryQuery {
  chamber: string;
  stateCode: string;
  partyAb: string;
  /** 1–14, or 0 for every register item. */
  itemNo: number;
  query: string;
  sort: PoliticianSummarySortKey;
  limit: number;
  offset: number;
}

/**
 * Normalise a request to exactly what the backend will do with it.
 *
 * THE CACHE KEY IS BUILT FROM THE RESULT, NEVER FROM THE RAW INPUT. The handler
 * lower-cases the chamber, upper-cases the state and party, drops an item
 * number outside 1–14, clamps the limit into [1, 200] with a default of 50 and
 * floors the offset at zero — so a key built from the raw input gives
 * `limit=1000` and `limit=200` two entries for one identical response, and
 * `house` / `House` two entries for one query. Clamping first also means the
 * caller cannot mint unbounded cache keys by varying an input the server
 * ignores.
 */
export function clampPoliticianSummaryQuery(
  input: Partial<PoliticianSummaryQuery> = {},
): PoliticianSummaryQuery {
  const itemNo = Math.trunc(Number(input.itemNo ?? 0));
  const rawLimit = Math.trunc(Number(input.limit ?? 0));
  const rawOffset = Math.trunc(Number(input.offset ?? 0));
  const sort = input.sort && input.sort in SUMMARY_SORT_ENUM ? input.sort : "declared_items";
  return {
    chamber: (input.chamber ?? "").trim().toLowerCase(),
    stateCode: (input.stateCode ?? "").trim().toUpperCase(),
    partyAb: (input.partyAb ?? "").trim().toUpperCase(),
    itemNo: Number.isFinite(itemNo) && itemNo >= 1 && itemNo <= 14 ? itemNo : 0,
    query: (input.query ?? "").trim(),
    sort,
    limit:
      !Number.isFinite(rawLimit) || rawLimit <= 0
        ? SUMMARY_LIMIT_DEFAULT
        : Math.min(rawLimit, SUMMARY_LIMIT_MAX),
    offset: Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0,
  };
}

/**
 * The hub table: one row per parliamentarian with their per-item counts.
 *
 * Takes an already-clamped query so the cache key, the request and the echoed
 * state can never disagree — pass `clampPoliticianSummaryQuery(...)`.
 */
export const listPoliticianSummaries = cache(
  withRetryAndNotFound(
    async (query: PoliticianSummaryQuery): Promise<ListPoliticianSummariesResponse | undefined> => {
      if (skipForBuild()) return undefined;
      const key = CACHE_KEYS.politicianSummaries(
        query.chamber,
        query.stateCode,
        query.partyAb,
        query.itemNo,
        query.query,
        query.sort,
        query.limit,
        query.offset,
      );
      const hit = readCached<ListPoliticianSummariesResponse>(
        ListPoliticianSummariesResponseSchema,
        await getCached<JsonValue>(key),
        (v) => v.summaries.length > 0,
      );
      if (hit) return hit;

      const resp = await createCacheablePoliticiansClient().listPoliticianSummaries({
        chamber: query.chamber,
        stateCode: query.stateCode,
        partyAb: query.partyAb,
        itemNo: query.itemNo,
        query: query.query,
        sort: SUMMARY_SORT_ENUM[query.sort],
        limit: query.limit,
        offset: query.offset,
      });
      // A filter combination with no members is a legitimate empty answer, but
      // it is indistinguishable on the wire from the kill switch and a cold MV
      // — so it is never cached. The cost is one live call for an empty filter;
      // the alternative is pinning an outage for 24h.
      if (resp.summaries.length > 0) {
        writeCached(ListPoliticianSummariesResponseSchema, key, resp);
      }
      return resp;
    },
  ),
);

/** Parliamentarians declaring real estate in one suburb. */
export const listSuburbPoliticians = cache(
  withRetryAndNotFound(
    async (salCode: string): Promise<ListSuburbPoliticiansResponse | undefined> => {
      if (!salCode) return undefined;
      if (skipForBuild()) return undefined;
      const key = CACHE_KEYS.suburbPoliticians(salCode);
      const hit = readCached<ListSuburbPoliticiansResponse>(
        ListSuburbPoliticiansResponseSchema,
        await getCached<JsonValue>(key),
        (v) => v.properties.length > 0,
      );
      if (hit) return hit;

      const resp = await createCacheablePoliticiansClient().listSuburbPoliticians({ salCode });
      if (resp.properties.length > 0) {
        writeCached(ListSuburbPoliticiansResponseSchema, key, resp);
      }
      return resp;
    },
  ),
);

/** Companies declared by one state's parliamentarians. */
export const listStatePoliticianHoldings = cache(
  withRetryAndNotFound(
    async (
      stateCode: string,
      limit: number = 20, // eslint-disable-line @typescript-eslint/no-inferrable-types
    ): Promise<ListStatePoliticianHoldingsResponse | undefined> => {
      if (!stateCode) return undefined;
      if (skipForBuild()) return undefined;
      const code = stateCode.toUpperCase();
      const key = CACHE_KEYS.statePoliticianHoldings(code, limit);
      const hit = readCached<ListStatePoliticianHoldingsResponse>(
        ListStatePoliticianHoldingsResponseSchema,
        await getCached<JsonValue>(key),
        (v) => v.stocks.length > 0,
      );
      if (hit) return hit;

      const resp = await createCacheablePoliticiansClient().listStatePoliticianHoldings({
        stateCode: code,
        limit,
      });
      if (resp.stocks.length > 0) {
        writeCached(ListStatePoliticianHoldingsResponseSchema, key, resp);
      }
      return resp;
    },
  ),
);

/** Register additions and removals over time. */
export const listRegisterChanges = cache(
  withRetryAndNotFound(
    async (
      limit: number = 100, // eslint-disable-line @typescript-eslint/no-inferrable-types
      offset: number = 0, // eslint-disable-line @typescript-eslint/no-inferrable-types
    ): Promise<ListRegisterChangesResponse | undefined> => {
      if (skipForBuild()) return undefined;
      const key = CACHE_KEYS.registerChanges("", "", limit, offset);
      const hit = readCached<ListRegisterChangesResponse>(
        ListRegisterChangesResponseSchema,
        await getCached<JsonValue>(key),
        (v) => v.events.length > 0,
      );
      if (hit) return hit;

      const resp = await createCacheablePoliticiansClient().listRegisterChanges({ limit, offset });
      if (resp.events.length > 0) {
        writeCached(ListRegisterChangesResponseSchema, key, resp);
      }
      return resp;
    },
  ),
);

/** Declared interests in companies carrying short interest. */
export const listShortInterestOverlap = cache(
  withRetryAndNotFound(
    async (
      minShortPercent: number = 2, // eslint-disable-line @typescript-eslint/no-inferrable-types
      limit: number = 50, // eslint-disable-line @typescript-eslint/no-inferrable-types
    ): Promise<ListShortInterestOverlapResponse | undefined> => {
      if (skipForBuild()) return undefined;
      const key = CACHE_KEYS.shortInterestOverlap(minShortPercent, limit);
      const hit = readCached<ListShortInterestOverlapResponse>(
        ListShortInterestOverlapResponseSchema,
        await getCached<JsonValue>(key),
        (v) => v.overlaps.length > 0,
      );
      if (hit) return hit;

      const resp = await createCacheablePoliticiansClient().listShortInterestOverlap({
        minShortPercent,
        limit,
      });
      if (resp.overlaps.length > 0) {
        writeCached(ListShortInterestOverlapResponseSchema, key, resp);
      }
      return resp;
    },
  ),
);

/** Thin slug list for the sitemap. */
export const getPoliticianSlugs = cache(
  withRetryAndNotFound(async (): Promise<{ slug: string; hasInterests: boolean }[]> => {
    if (skipForBuild()) return [];
    const resp = await createCacheablePoliticiansClient().listPoliticians({ limit: 500 });
    return resp.politicians.map((p) => ({
      slug: p.slug,
      hasInterests: p.declaredListedCount > 0 || p.declaredPropertyCount > 0,
    }));
  }),
);
