import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import {
  OwnershipService,
  GetOwnershipOverviewResponseSchema,
  ListInstitutionsResponseSchema,
  GetInstitutionResponseSchema,
  GetStockOwnershipResponseSchema,
  type GetOwnershipOverviewResponse,
  type ListInstitutionsResponse,
  type GetInstitutionResponse,
  type GetStockOwnershipResponse,
} from "~/gen/shorts/v1alpha1/ownership_pb";
import { cache } from "react";
import {
  SERVER_SHORTS_API_URL,
  serverFetchWithUserAgent,
  skipForBuild,
} from "./config";
import { CACHE_KEYS, OWNERSHIP_TTL, getCached, setCached } from "@/lib/kv-cache";
import { withRetryAndNotFound, withRetryAndThrowNotFound } from "./withRetry";

// ISR-tagged transport. LOAD-BEARING: without `next`, serverFetchWithUserAgent
// forces no-store on a POST at Vercel runtime and an ISR regeneration throws
// "static to dynamic" (getPoliticians.ts, getEconomy.ts).
const isrOwnershipFetch: typeof fetch = (input, init) =>
  serverFetchWithUserAgent(input, {
    ...init,
    next: { revalidate: 3600, tags: ["ownership"] },
  } as RequestInit);

function ownershipClient() {
  return createClient(
    OwnershipService,
    createConnectTransport({ fetch: isrOwnershipFetch, baseUrl: SERVER_SHORTS_API_URL }),
  );
}

/**
 * The KV last-good layer: a cached projection is served while it parses and
 * is populated. An empty entry is a miss (getPoliticians.ts readCached), and
 * an empty response is never written: a database without the ownership tables
 * answers {}, and caching that would pin it for the TTL.
 */
async function cachedRead<T>(
  key: string,
  schema: Parameters<typeof fromJson>[0],
  isPopulated: (value: T) => boolean,
  fetchFresh: () => Promise<T>,
): Promise<T> {
  const hit = await getCached<JsonValue>(key);
  if (hit != null) {
    try {
      const parsed = fromJson(schema, hit) as T;
      if (isPopulated(parsed)) return parsed;
    } catch {
      // The proto changed since the entry was written: read fresh.
    }
  }
  const fresh = await fetchFresh();
  if (isPopulated(fresh)) {
    try {
      void setCached(key, toJson(schema, fresh as never) as JsonValue, OWNERSHIP_TTL);
    } catch {
      // Never let a cache write break a render.
    }
  }
  return fresh;
}

/** The map of investors and the aggregated ownership view. */
export const getOwnershipOverview = cache(
  withRetryAndNotFound(async (): Promise<GetOwnershipOverviewResponse | undefined> => {
    if (skipForBuild()) return undefined;
    return cachedRead<GetOwnershipOverviewResponse>(
      CACHE_KEYS.ownershipOverview(),
      GetOwnershipOverviewResponseSchema,
      (v) => v.noticesParsed > 0 || v.superFunds > 0,
      () => ownershipClient().getOwnershipOverview({}),
    );
  }),
);

/** Institutions on the map, by kind or name. */
export const listInstitutions = cache(
  withRetryAndNotFound(
    async (
      // Annotated for withRetryAndNotFound's TArgs inference (getPoliticians.ts).
      kind: string = "", // eslint-disable-line @typescript-eslint/no-inferrable-types
      query: string = "", // eslint-disable-line @typescript-eslint/no-inferrable-types
      limit: number = 200, // eslint-disable-line @typescript-eslint/no-inferrable-types
      offset: number = 0, // eslint-disable-line @typescript-eslint/no-inferrable-types
    ): Promise<ListInstitutionsResponse | undefined> => {
      if (skipForBuild()) return undefined;
      return cachedRead<ListInstitutionsResponse>(
        CACHE_KEYS.ownershipInstitutions(kind, query, limit, offset),
        ListInstitutionsResponseSchema,
        (v) => v.institutions.length > 0,
        () => ownershipClient().listInstitutions({ kind, query, limit, offset }),
      );
    },
  ),
);

async function readInstitution(slug: string): Promise<GetInstitutionResponse | undefined> {
  if (skipForBuild()) return undefined;
  return cachedRead<GetInstitutionResponse>(
    CACHE_KEYS.ownershipInstitution(slug),
    GetInstitutionResponseSchema,
    (v) => v.institution != null,
    () => ownershipClient().getInstitution({ slug }),
  );
}

/**
 * One institution's holdings. Undefined when it is not on the map AND when the
 * read failed, so it suits a surface that degrades either way (the social
 * card). A page that ISR caches must tell the two apart: getInstitutionOrNotFound.
 */
export const getInstitution = cache(withRetryAndNotFound(readInstitution));

/**
 * The same read for /ownership/[slug]: a slug the API does not know (Connect
 * NotFound; GetInstitution never answers an empty institution) throws
 * NotFoundError, and undefined means only that the read failed, so the page
 * can fail its render instead of caching a 404 for the hour.
 */
export const getInstitutionOrNotFound = cache(withRetryAndThrowNotFound(readInstitution));

/** Who holds one stock. */
export const getStockOwnership = cache(
  withRetryAndNotFound(async (stockCode: string): Promise<GetStockOwnershipResponse | undefined> => {
    if (skipForBuild()) return undefined;
    return cachedRead<GetStockOwnershipResponse>(
      CACHE_KEYS.stockOwnership(stockCode),
      GetStockOwnershipResponseSchema,
      (v) => v.holders.length > 0 || v.fundHoldings.length > 0,
      () => ownershipClient().getStockOwnership({ stockCode }),
    );
  }),
);
