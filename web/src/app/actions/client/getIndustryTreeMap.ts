import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";
import { type IndustryTreeMap } from "~/gen/stocks/v1alpha1/stocks_pb";
import { type ViewMode } from "~/gen/shorts/v1alpha1/shorts_pb";
import { SHORTS_API_URL } from "../config";
import { formatPeriodForAPI } from "~/lib/period-utils";
import { retryWithBackoff } from "@/lib/retry";

const RETRY_OPTIONS = {
  maxRetries: 3,
  initialDelayMs: 500,
  maxDelayMs: 5000,
};

/**
 * Client-side version of getIndustryTreeMap
 * Calls the backend API directly from the browser
 * No caching, no server-side execution - pure client-side
 * Includes retry logic for transient failures
 */
export const getIndustryTreeMapClient = async (
  period: string,
  limit: number,
  viewMode: ViewMode,
): Promise<IndustryTreeMap> => {
  const transport = createConnectTransport({
    baseUrl:
      process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT ?? SHORTS_API_URL,
  });
  const client = createClient(ShortedStocksService, transport);

  return retryWithBackoff(
    () =>
      client.getIndustryTreeMap({
        period: formatPeriodForAPI(period),
        limit,
        viewMode,
      }),
    RETRY_OPTIONS,
  );
};
