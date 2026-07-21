import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import {
  ShortedStocksService,
  type GetEconomicSeriesResponse,
  type GetStateCompanyAggregatesResponse,
  type ListEconomicSeriesResponse,
  type ListStateCompaniesResponse,
} from "~/gen/shorts/v1alpha1/shorts_pb";
import { SHORTS_API_URL } from "../config";
import { retryWithBackoff } from "@/lib/retry";
import { getSessionCached, setSessionCached } from "@/lib/session-cache";

const RETRY_OPTIONS = { maxRetries: 3, initialDelayMs: 500, maxDelayMs: 5000 };

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
  const client = createClient(ShortedStocksService, transport);

  try {
    const result = await retryWithBackoff(
      () => client.getEconomicSeries({ seriesKeys }),
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
  const client = createClient(ShortedStocksService, transport);

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
  const client = createClient(ShortedStocksService, transport);

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
  const client = createClient(ShortedStocksService, transport);

  try {
    const result = await retryWithBackoff(
      () => client.listEconomicSeries({ topic, metric, regionType, limit: 500 }),
      RETRY_OPTIONS,
    );
    setSessionCached(cacheKey, result);
    return result;
  } catch {
    return undefined;
  }
}
