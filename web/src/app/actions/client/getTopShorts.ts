import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";
import { type GetTopShortsResponse } from "~/gen/shorts/v1alpha1/shorts_pb";
import { formatPeriodForAPI } from "~/lib/period-utils";
import { SHORTS_API_URL } from "../config";
import { retryWithBackoff } from "@/lib/retry";

const RETRY_OPTIONS = {
  maxRetries: 3,
  initialDelayMs: 500,
  maxDelayMs: 5000,
};

/**
 * Client-side version of getTopShortsData
 * Calls the backend API directly from the browser
 * No caching, no server-side execution - pure client-side
 * Includes retry logic for transient failures
 */
export const getTopShortsDataClient = async (
  period: string,
  limit: number,
  offset: number,
): Promise<GetTopShortsResponse> => {
  // Use relative URL so requests go through Next.js rewrites (avoids CORS)
  const transport = createConnectTransport({
    baseUrl: typeof window !== "undefined" ? "" : SHORTS_API_URL,
  });

  const client = createClient(ShortedStocksService, transport);

  return retryWithBackoff(
    () =>
      client.getTopShorts({
        period: formatPeriodForAPI(period),
        limit,
        offset,
      }),
    RETRY_OPTIONS,
  );
};
