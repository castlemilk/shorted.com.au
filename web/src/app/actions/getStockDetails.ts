import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";
import { type StockDetails } from "~/gen/stocks/v1alpha1/stocks_pb";
import { cache } from "react";
import { unstable_cache } from "next/cache";
import { SHORTS_API_URL, serverFetchWithUserAgent } from "./config";
import { withRetryAndNotFound } from "./withRetry";
import {
  STOCK_PAGE_CACHE_SECONDS,
  normalizeStockPageCacheCode,
  stockPageCacheTags,
  toNextDataCacheValue,
} from "./stockPageCache";

async function fetchStockDetails(productCode: string): Promise<StockDetails> {
  const transport = createConnectTransport({
    fetch: serverFetchWithUserAgent,
    baseUrl: SHORTS_API_URL,
  });
  const client = createClient(ShortedStocksService, transport);
  return client.getStockDetails({ productCode });
}

function getCachedStockDetails(productCode: string): Promise<StockDetails> {
  const cacheCode = normalizeStockPageCacheCode(productCode);
  return unstable_cache(
    async () =>
      toNextDataCacheValue(await fetchStockDetails(cacheCode)) as StockDetails,
    ["stock-details", cacheCode],
    {
      tags: stockPageCacheTags("stock-details", cacheCode),
      revalidate: STOCK_PAGE_CACHE_SECONDS,
    },
  )();
}

export const getStockDetails = cache(
  withRetryAndNotFound(async (productCode: string): Promise<StockDetails> => {
    return getCachedStockDetails(productCode);
  }),
);
