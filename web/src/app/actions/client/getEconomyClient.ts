import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import {
  type GetEconomicSeriesResponse,
  type GetStateCompanyAggregatesResponse,
  type ListEconomicSeriesResponse,
  type ListSeriesCorrelationsResponse,
  type ListStateCompaniesResponse,
} from "~/gen/shorts/v1alpha1/economy_pb";
import { EconomyService } from "~/gen/shorts/v1alpha1/economy_pb";
import { SHORTS_API_URL } from "../config";
import { retryWithBackoff } from "@/lib/retry";
import { getSessionCached, setSessionCached } from "@/lib/session-cache";

const RETRY_OPTIONS = { maxRetries: 3, initialDelayMs: 500, maxDelayMs: 5000 };

/**
 * The server refuses more than 50 series_keys per request — an ERROR, not a
 * truncation (services/shorts/.../economy.go). This wrapper swallows errors and
 * returns undefined, so an over-long list would have rendered as "not enough
 * data" with nothing anywhere saying the request was rejected.
 *
 * The national overlay list crossed 50 the day the global catalog was added, so
 * this is chunked at the choke point rather than at the one call site that
 * happened to hit it first.
 */
const MAX_SERIES_KEYS_PER_REQUEST = 50;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Browser-side economic series fetch (for interactive charts). */
export async function getEconomicSeriesClient(
  seriesKeys: string[],
): Promise<GetEconomicSeriesResponse | undefined> {
  const cacheKey = `economicSeries:${seriesKeys.join(",")}`;
  const cached = getSessionCached<GetEconomicSeriesResponse>(cacheKey);
  if (cached) return cached;

  const transport = createConnectTransport({
    baseUrl: typeof window !== "undefined" ? "" : SHORTS_API_URL,
  });
  const client = createClient(EconomyService, transport);

  try {
    const batches = chunk(seriesKeys, MAX_SERIES_KEYS_PER_REQUEST);
    const responses = await Promise.all(
      batches.map((keys) =>
        retryWithBackoff(
          () => client.getEconomicSeries({ seriesKeys: keys }),
          RETRY_OPTIONS,
        ),
      ),
    );
    // One batch is the overwhelmingly common case; return its response
    // untouched so nothing depends on the merged shape unless it has to.
    const result =
      responses.length === 1
        ? responses[0]!
        : ({
            ...responses[0]!,
            series: responses.flatMap((response) => response.series),
          } as GetEconomicSeriesResponse);
    setSessionCached(cacheKey, result);
    return result;
  } catch {
    return undefined;
  }
}

/** Browser-side ranked correlation lookup for an economic base series. */
export async function listSeriesCorrelationsClient(
  baseSeriesKey: string,
  windowMonths = 24,
  minAbsR = 0,
  limit = 250,
): Promise<ListSeriesCorrelationsResponse | undefined> {
  const cacheKey = `seriesCorrelations:${baseSeriesKey}:${windowMonths}:${minAbsR}:${limit}`;
  const cached = getSessionCached<ListSeriesCorrelationsResponse>(cacheKey);
  if (cached) return cached;

  const transport = createConnectTransport({
    baseUrl: typeof window !== "undefined" ? "" : SHORTS_API_URL,
  });
  const client = createClient(EconomyService, transport);

  try {
    const result = await retryWithBackoff(
      () =>
        client.listSeriesCorrelations({
          baseSeriesKey,
          windowMonths,
          minAbsR,
          limit,
        }),
      RETRY_OPTIONS,
    );
    setSessionCached(cacheKey, result);
    return result;
  } catch {
    return undefined;
  }
}

/** Browser-side per-state company-exposure aggregates (one call = all states). */
export async function getStateCompanyAggregatesClient(): Promise<
  GetStateCompanyAggregatesResponse | undefined
> {
  const cacheKey = "stateCompanyAggregates";
  const cached = getSessionCached<GetStateCompanyAggregatesResponse>(cacheKey);
  if (cached) return cached;

  const transport = createConnectTransport({
    baseUrl: typeof window !== "undefined" ? "" : SHORTS_API_URL,
  });
  const client = createClient(EconomyService, transport);

  try {
    const result = await retryWithBackoff(
      () => client.getStateCompanyAggregates({}),
      RETRY_OPTIONS,
    );
    setSessionCached(cacheKey, result);
    return result;
  } catch {
    return undefined;
  }
}

/** Browser-side top companies operating in a state (dossier "Operating here"). */
export async function listStateCompaniesClient(
  state: string,
  limit = 8,
): Promise<ListStateCompaniesResponse | undefined> {
  const cacheKey = `stateCompanies:${state}:${limit}`;
  const cached = getSessionCached<ListStateCompaniesResponse>(cacheKey);
  if (cached) return cached;

  const transport = createConnectTransport({
    baseUrl: typeof window !== "undefined" ? "" : SHORTS_API_URL,
  });
  const client = createClient(EconomyService, transport);

  try {
    const result = await retryWithBackoff(
      () => client.listStateCompanies({ state, limit }),
      RETRY_OPTIONS,
    );
    setSessionCached(cacheKey, result);
    return result;
  } catch {
    return undefined;
  }
}

/** Browser-side economic series catalog fetch. */
export async function listEconomicSeriesClient(
  topic = "",
  metric = "",
  regionType = "",
): Promise<ListEconomicSeriesResponse | undefined> {
  const cacheKey = `economicSeriesCatalog:${topic}:${metric}:${regionType}`;
  const cached = getSessionCached<ListEconomicSeriesResponse>(cacheKey);
  if (cached) return cached;

  const transport = createConnectTransport({
    baseUrl: typeof window !== "undefined" ? "" : SHORTS_API_URL,
  });
  const client = createClient(EconomyService, transport);

  try {
    const result = await retryWithBackoff(
      () =>
        client.listEconomicSeries({ topic, metric, regionType, limit: 500 }),
      RETRY_OPTIONS,
    );
    setSessionCached(cacheKey, result);
    return result;
  } catch {
    return undefined;
  }
}
