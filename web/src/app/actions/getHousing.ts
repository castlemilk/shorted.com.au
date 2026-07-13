import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import {
  ShortedStocksService,
  type GetHousingOverviewResponse,
  type GetHousePriceSeriesResponse,
  type ListStateSuburbsResponse,
  type GetSuburbProfileResponse,
  type ListSuburbPriceDropsResponse,
  type ListSuburbDropListingsResponse,
} from "~/gen/shorts/v1alpha1/shorts_pb";
import { cache } from "react";
import { SERVER_SHORTS_API_URL, serverFetchWithUserAgent } from "./config";
import { withRetryAndNotFound } from "./withRetry";
import { suburbSlug } from "@/lib/housing/states";

function createHousingClient() {
  const transport = createConnectTransport({
    fetch: serverFetchWithUserAgent,
    baseUrl: SERVER_SHORTS_API_URL,
  });
  return createClient(ShortedStocksService, transport);
}

/** Latest house-price headline metrics per region (optionally filtered by type). */
export const getHousingOverview = cache(
  withRetryAndNotFound(
    async (regionType: string = ""): Promise<GetHousingOverviewResponse> => { // eslint-disable-line @typescript-eslint/no-inferrable-types
      const client = createHousingClient();
      return client.getHousingOverview({ regionType });
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
