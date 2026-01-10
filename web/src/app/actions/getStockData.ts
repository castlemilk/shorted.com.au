import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";
import { type TimeSeriesData } from "~/gen/stocks/v1alpha1/stocks_pb";
import { cache } from "react";
import { SHORTS_API_URL } from "./config";
import { formatPeriodForAPI } from "~/lib/period-utils";
import { withRetryAndNotFound } from "./withRetry";

// React cache() provides request deduplication during a single render
// Page-level ISR (revalidate) handles longer-term caching
export const getStockData = cache(
  withRetryAndNotFound(
    async (productCode: string, period: string): Promise<TimeSeriesData> => {
      const transport = createConnectTransport({
        baseUrl:
          process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT ?? SHORTS_API_URL,
      });
      const client = createClient(ShortedStocksService, transport);
      const response = await client.getStockData({
        productCode,
        period: formatPeriodForAPI(period),
      });
      return response;
    },
  ),
);
