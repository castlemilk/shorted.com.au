import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";
import { type TimeSeriesData } from "~/gen/stocks/v1alpha1/stocks_pb";
import { cache } from "react";
import { unstable_cache } from "next/cache";
import { SHORTS_API_URL, serverFetchWithUserAgent } from "./config";
import { formatPeriodForAPI } from "~/lib/period-utils";
import { withRetryAndNotFound } from "./withRetry";
import {
  STOCK_PAGE_CACHE_SECONDS,
  normalizeStockPageCacheCode,
  stockPageCacheTags,
  toNextDataCacheValue,
} from "./stockPageCache";

async function fetchStockData(
  productCode: string,
  period: string,
): Promise<TimeSeriesData> {
  const transport = createConnectTransport({
    fetch: serverFetchWithUserAgent,
    baseUrl: SHORTS_API_URL,
  });
  const client = createClient(ShortedStocksService, transport);
  return client.getStockData({
    productCode,
    period,
  });
}

function getCachedStockData(
  productCode: string,
  period: string,
): Promise<TimeSeriesData> {
  const cacheCode = normalizeStockPageCacheCode(productCode);
  const apiPeriod = formatPeriodForAPI(period);
  return unstable_cache(
    async () =>
      toNextDataCacheValue(await fetchStockData(cacheCode, apiPeriod)) as TimeSeriesData,
    ["stock-data", cacheCode, apiPeriod],
    {
      tags: stockPageCacheTags("stock-data", cacheCode, apiPeriod),
      revalidate: STOCK_PAGE_CACHE_SECONDS,
    },
  )();
}

// React cache() provides request deduplication during a single render
// unstable_cache persists public stock history across route regenerations.
export const getStockData = cache(
  withRetryAndNotFound(
    async (productCode: string, period: string): Promise<TimeSeriesData> => {
      return getCachedStockData(productCode, period);
    },
  ),
);
