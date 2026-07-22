import { fromJson, type JsonValue } from "@bufbuild/protobuf";
import {
  IndustryTreeMapSchema,
  type IndustryTreeMap,
} from "~/gen/stocks/v1alpha1/stocks_pb";
import { type ViewMode } from "~/gen/shorts/v1alpha1/market_pb";
import { formatPeriodForAPI } from "~/lib/period-utils";
import { retryWithBackoff } from "@/lib/retry";
import { getSessionCached, setSessionCached } from "@/lib/session-cache";

const RETRY_OPTIONS = {
  maxRetries: 3,
  initialDelayMs: 500,
  maxDelayMs: 5000,
};

function buildIndustryTreeMapEdgeUrl(
  period: string,
  limit: number,
  viewMode: ViewMode,
): string {
  const params = new URLSearchParams({
    period: formatPeriodForAPI(period),
    limit: String(limit),
    viewMode: String(viewMode),
  });
  return `/edge/v1/industry-treemap?${params.toString()}`;
}

async function fetchIndustryTreeMapFromEdge(
  period: string,
  limit: number,
  viewMode: ViewMode,
  forceRefresh: boolean,
): Promise<IndustryTreeMap> {
  const response = await fetch(
    buildIndustryTreeMapEdgeUrl(period, limit, viewMode),
    {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
      cache: forceRefresh ? "reload" : "default",
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch treemap data: ${response.status}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new Error("Failed to fetch treemap data: non-JSON response");
  }

  return fromJson(
    IndustryTreeMapSchema,
    (await response.json()) as JsonValue,
  );
}

/**
 * Client-side version of getIndustryTreeMap
 * Calls the Cloudflare Worker edge-read facade through a same-origin rewrite
 * Uses sessionStorage cache (5-min TTL) to avoid redundant fetches
 * Includes retry logic for transient failures
 */
export const getIndustryTreeMapClient = async (
  period: string,
  limit: number,
  viewMode: ViewMode,
  forceRefresh = false,
): Promise<IndustryTreeMap> => {
  const cacheKey = `treeMap:${period}:${limit}:${viewMode}`;

  if (!forceRefresh) {
    const cached = getSessionCached<IndustryTreeMap>(cacheKey);
    if (cached) return cached;
  }

  const result = await retryWithBackoff(
    () =>
      fetchIndustryTreeMapFromEdge(period, limit, viewMode, forceRefresh),
    RETRY_OPTIONS,
  );

  setSessionCached(cacheKey, result);
  return result;
};
