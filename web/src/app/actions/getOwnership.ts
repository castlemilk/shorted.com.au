import {
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
import { skipForBuild } from "./config";
import { CACHE_KEYS } from "@/lib/kv-cache";
import { withRetryAndNotFound, withRetryAndThrowNotFound } from "./withRetry";
import { cachedRead, ownershipClient } from "./ownership-shared";

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
