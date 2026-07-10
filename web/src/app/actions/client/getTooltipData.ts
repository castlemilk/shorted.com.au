import type {
  SerializedStockDetails,
  SerializedTimeSeriesData,
  TooltipData,
} from "../tooltip/getTooltipData";
import { getSessionCached, setSessionCached } from "@/lib/session-cache";

export type {
  SerializedStockDetails,
  SerializedTimeSeriesData,
  TooltipData,
};

const TOOLTIP_CACHE_MAX_AGE_MS = 60 * 60 * 1000;

async function fetchEdgeJsonOrNull<T>(path: string): Promise<T | null> {
  const response = await fetch(path, {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  });

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Failed to fetch tooltip data: ${response.status}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new Error("Failed to fetch tooltip data: non-JSON response");
  }

  return (await response.json()) as T;
}

export async function getTooltipDataClient(
  productCode: string,
): Promise<TooltipData> {
  const code = productCode.trim().toUpperCase();
  const cacheKey = `tooltip-edge:${code}`;
  const cached = getSessionCached<TooltipData>(
    cacheKey,
    TOOLTIP_CACHE_MAX_AGE_MS,
  );
  if (cached) return cached;

  const [stockDetails, timeSeriesData] = await Promise.all([
    fetchEdgeJsonOrNull<SerializedStockDetails>(
      `/edge/v1/stock/${encodeURIComponent(code)}/details`,
    ).catch(() => null),
    fetchEdgeJsonOrNull<SerializedTimeSeriesData>(
      `/edge/v1/stock/${encodeURIComponent(code)}/data?period=1M`,
    ).catch(() => null),
  ]);

  const data = {
    stockDetails,
    timeSeriesData,
  };
  setSessionCached(cacheKey, data);
  return data;
}
