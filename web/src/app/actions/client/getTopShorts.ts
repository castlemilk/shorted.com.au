import { createConnectTransport } from "@connectrpc/connect-web";
import { createPromiseClient } from "@connectrpc/connect";
import { toPlainMessage } from "@bufbuild/protobuf";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_connect";
import { formatPeriodForAPI } from "~/lib/period-utils";
import { SHORTS_API_URL } from "../config";

/**
 * Client-side version of getTopShortsData
 * Calls the backend API directly from the browser
 * No caching, no server-side execution - pure client-side
 */
export const getTopShortsDataClient = async (
  period: string,
  limit: number,
  offset: number,
) => {
  const transport = createConnectTransport({
    baseUrl: process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT ?? SHORTS_API_URL,
    // Add timeout for long-running requests
    // This allows the request to take longer without hitting server limits
  });

  const client = createPromiseClient(ShortedStocksService, transport);
  const response = await client.getTopShorts({
    period: formatPeriodForAPI(period),
    limit,
    offset,
  });
  return toPlainMessage(response);
};
