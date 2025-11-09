import { createConnectTransport } from "@connectrpc/connect-web";
import { createPromiseClient } from "@connectrpc/connect";
import { type PlainMessage, toPlainMessage } from "@bufbuild/protobuf";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_connect";
import { type IndustryTreeMap } from "~/gen/stocks/v1alpha1/stocks_pb";
import { type ViewMode } from "~/gen/shorts/v1alpha1/shorts_pb";
import { SHORTS_API_URL } from "../config";
import { formatPeriodForAPI } from "~/lib/period-utils";

/**
 * Client-side version of getIndustryTreeMap
 * Calls the backend API directly from the browser
 * No caching, no server-side execution - pure client-side
 */
export const getIndustryTreeMapClient = async (
  period: string,
  limit: number,
  viewMode: ViewMode,
): Promise<PlainMessage<IndustryTreeMap>> => {
  const transport = createConnectTransport({
    baseUrl:
      process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT ?? SHORTS_API_URL,
    // Add timeout for long-running requests
  });
  const client = createPromiseClient(ShortedStocksService, transport);

  const response = await client.getIndustryTreeMap({
    period: formatPeriodForAPI(period),
    limit,
    viewMode,
  });

  return toPlainMessage(response);
};

