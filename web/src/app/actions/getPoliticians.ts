import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
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
  GetRegisterActivityResponseSchema,
  PoliticianSummarySort,
  RegisterChangeKind,
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
  type GetRegisterActivityResponse,
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

/*
 * ---------------------------------------------------------------------------
 * The register ACTIVITY explorer (/politicians/changes).
 *
 * Two rpcs feed one surface: `GetRegisterActivity` for the weekly strip and the
 * rails, `ListRegisterChanges` for the feed. They are cached separately because
 * they have different inputs — the rails move only with the WINDOW, the feed
 * moves with every filter — and sharing a key would make one filter's feed
 * invalidate every reader's rails.
 * ---------------------------------------------------------------------------
 */

/**
 * The only windows the activity rpc serves.
 *
 * Mirrors `registerActivityWindows` in politicians_discovery.go. Kept as a
 * literal rather than derived from anything: the backend's list IS the contract,
 * and a client that offers a fifth window silently gets one of these four back.
 */
export const REGISTER_ACTIVITY_WINDOWS = [30, 90, 180, 365] as const;

/**
 * Normalise a window to one the backend actually serves.
 *
 * ROUNDS UP, exactly as `clampRegisterActivityWindow` does in
 * politicians_discovery.go: a request between two windows gets the LARGER one
 * (45 -> 90) so a caller never receives less than it asked for. Zero and
 * negatives default to 90.
 *
 * This runs BEFORE the cache key is built, for the reason the backend gives:
 * a key must never describe a window other than the one that produced it.
 */
export function clampRegisterActivityWindow(windowDays: number): number {
  const days = Math.trunc(Number(windowDays));
  if (!Number.isFinite(days) || days <= 0) return 90;
  for (const window of REGISTER_ACTIVITY_WINDOWS) {
    if (days <= window) return window;
  }
  return REGISTER_ACTIVITY_WINDOWS[REGISTER_ACTIVITY_WINDOWS.length - 1] as number;
}

/**
 * The activity explorer's weekly strip and rails.
 *
 * Counts and dates only. The rails are count orderings over the WHOLE register
 * in the window — the rpc takes no member/party filter — so a surface must never
 * caption them as though they described the feed's current filter.
 */
export const getRegisterActivity = cache(
  withRetryAndNotFound(
    async (
      windowDays: number = 90, // eslint-disable-line @typescript-eslint/no-inferrable-types
    ): Promise<GetRegisterActivityResponse | undefined> => {
      if (skipForBuild()) return undefined;
      const window = clampRegisterActivityWindow(windowDays);
      const key = CACHE_KEYS.registerActivity(window);
      const hit = readCached<GetRegisterActivityResponse>(
        GetRegisterActivityResponseSchema,
        await getCached<JsonValue>(key),
        // Not `undatedCurrentCount > 0`: that field is populated even when every
        // dated measure is empty, so it cannot distinguish a live answer from a
        // cold MV. The weeks and the members are what the surface renders.
        (v) => v.weeks.length > 0 || v.activeMembers.length > 0,
      );
      if (hit) return hit;

      const resp = await createCacheablePoliticiansClient().getRegisterActivity({
        windowDays: window,
      });
      // NEVER cache an empty response: the kill switch and a cold MV both return
      // {}, and caching that pins the empty state for 24h.
      if (resp.weeks.length > 0 || resp.activeMembers.length > 0) {
        writeCached(GetRegisterActivityResponseSchema, key, resp);
      }
      return resp;
    },
  ),
);

/** The kinds of register event the feed can be narrowed to. `""` is both. */
export type RegisterChangeKindKey = "" | "added" | "removed";

const CHANGE_KIND_ENUM: Record<RegisterChangeKindKey, RegisterChangeKind> = {
  "": RegisterChangeKind.UNSPECIFIED,
  added: RegisterChangeKind.ADDED,
  removed: RegisterChangeKind.REMOVED,
};

/** Mirrors `clampLimit(m.Limit, 100, 500)` in politicians.go. */
export const CHANGE_FEED_LIMIT_DEFAULT = 100;
export const CHANGE_FEED_LIMIT_MAX = 500;

export interface RegisterChangeFeedQuery {
  /**
   * The window's first day, as `YYYY-MM-DD`.
   *
   * A DAY, not an instant: the window is a count of days, and anchoring it to a
   * UTC midnight means the cache key turns over once a day instead of once a
   * request. Empty means no lower bound.
   */
  since: string;
  kind: RegisterChangeKindKey;
  /** A canonical slug. Never derived here — it comes from search or a link. */
  politicianSlug: string;
  /** 1–14, or 0 for every register item. */
  itemNo: number;
  partyAb: string;
  chamber: string;
  limit: number;
  offset: number;
}

/** `YYYY-MM-DD` for the UTC day `windowDays` before now. */
export function registerWindowStart(windowDays: number, now: Date = new Date()): string {
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
      clampRegisterActivityWindow(windowDays) * 86_400_000,
  );
  return start.toISOString().slice(0, 10);
}

/**
 * Normalise a feed request to exactly what the backend will do with it.
 *
 * THE CACHE KEY IS BUILT FROM THE RESULT, NEVER FROM THE RAW INPUT — the same
 * rule, and the same reasons, as `clampPoliticianSummaryQuery`: the handler
 * lower-cases the slug and the chamber, upper-cases the party, drops an item
 * number outside 1–14, clamps the limit into [1, 500] with a default of 100 and
 * floors the offset at zero.
 */
export function clampRegisterChangeFeedQuery(
  input: Partial<RegisterChangeFeedQuery> = {},
): RegisterChangeFeedQuery {
  const itemNo = Math.trunc(Number(input.itemNo ?? 0));
  const rawLimit = Math.trunc(Number(input.limit ?? 0));
  const rawOffset = Math.trunc(Number(input.offset ?? 0));
  const kind = input.kind && input.kind in CHANGE_KIND_ENUM ? input.kind : "";
  const since = (input.since ?? "").trim();
  return {
    // A malformed date is dropped rather than passed on: an unparseable string
    // would become an Invalid Date and reach the wire as a nonsense instant.
    since: /^\d{4}-\d{2}-\d{2}$/.test(since) ? since : "",
    kind,
    politicianSlug: (input.politicianSlug ?? "").trim().toLowerCase(),
    itemNo: Number.isFinite(itemNo) && itemNo >= 1 && itemNo <= 14 ? itemNo : 0,
    partyAb: (input.partyAb ?? "").trim().toUpperCase(),
    chamber: (input.chamber ?? "").trim().toLowerCase(),
    limit:
      !Number.isFinite(rawLimit) || rawLimit <= 0
        ? CHANGE_FEED_LIMIT_DEFAULT
        : Math.min(rawLimit, CHANGE_FEED_LIMIT_MAX),
    offset: Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0,
  };
}

/**
 * The activity feed: register additions and removals under the discovery
 * filters.
 *
 * Takes an already-clamped query so the cache key, the request and the echoed
 * state can never disagree — pass `clampRegisterChangeFeedQuery(...)`.
 */
export const listRegisterChangeFeed = cache(
  withRetryAndNotFound(
    async (query: RegisterChangeFeedQuery): Promise<ListRegisterChangesResponse | undefined> => {
      if (skipForBuild()) return undefined;
      const key = CACHE_KEYS.registerChangeFeed(
        query.since,
        query.kind,
        query.politicianSlug,
        query.itemNo,
        query.partyAb,
        query.chamber,
        query.limit,
        query.offset,
      );
      const hit = readCached<ListRegisterChangesResponse>(
        ListRegisterChangesResponseSchema,
        await getCached<JsonValue>(key),
        (v) => v.events.length > 0,
      );
      if (hit) return hit;

      const resp = await createCacheablePoliticiansClient().listRegisterChanges({
        // `T00:00:00Z`, not the bare date: parsing "YYYY-MM-DD" is UTC in every
        // engine, but the explicit instant is what the field actually is.
        since: query.since ? timestampFromDate(new Date(`${query.since}T00:00:00Z`)) : undefined,
        kind: CHANGE_KIND_ENUM[query.kind],
        politicianSlug: query.politicianSlug,
        itemNo: query.itemNo,
        partyAb: query.partyAb,
        chamber: query.chamber,
        limit: query.limit,
        offset: query.offset,
      });
      // A filter combination with no events is a legitimate empty answer, but it
      // is indistinguishable on the wire from the kill switch and a cold MV — so
      // it is never cached. The cost is one live call for an empty filter; the
      // alternative is pinning an outage for 24h.
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
