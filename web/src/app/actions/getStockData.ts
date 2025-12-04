import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient, ConnectError, Code } from "@connectrpc/connect";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";
import { type TimeSeriesData } from "~/gen/stocks/v1alpha1/stocks_pb";
import { cache } from "react";
import { SHORTS_API_URL } from "./config";
import { formatPeriodForAPI } from "~/lib/period-utils";

// React cache() provides request deduplication during a single render
// Page-level ISR (revalidate) handles longer-term caching
export const getStockData = cache(
  async (
    productCode: string,
    period: string,
  ): Promise<TimeSeriesData | undefined> => {
    const transport = createConnectTransport({
      baseUrl:
        process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT ?? SHORTS_API_URL,
    });
    const client = createClient(ShortedStocksService, transport);
    try {
      const response = await client.getStockData({
        productCode,
        period: formatPeriodForAPI(period),
      });
      return response;
    } catch (err) {
      if (err instanceof ConnectError) {
        if (err.code === Code.NotFound) {
          // Stock data not found - return undefined to handle gracefully
          return undefined;
        }
        throw err;
      }
      throw err;
    }
  },
);
