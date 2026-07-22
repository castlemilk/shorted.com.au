import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { StockService } from "~/gen/shorts/v1alpha1/stock_pb";
import { type StockDetails } from "~/gen/stocks/v1alpha1/stocks_pb";
import { cache } from "react";
import { unstable_cache } from "next/cache";
import { SHORTS_API_URL, serverFetchOutsideNextCache } from "./config";
import { fetchEdgeReadJson } from "./edgeRead";
import { withRetryAndNotFound } from "./withRetry";
import {
  STOCK_PAGE_CACHE_SECONDS,
  normalizeStockPageCacheCode,
  stockPageCacheTags,
  toNextDataCacheValue,
} from "./stockPageCache";

async function fetchStockDetails(productCode: string): Promise<StockDetails> {
  const edgeResponse = await fetchEdgeReadJson<StockDetails>(
    `/edge/v1/stock/${encodeURIComponent(productCode)}/details`,
  );
  if (edgeResponse) return edgeResponse;

  const transport = createConnectTransport({
    fetch: serverFetchOutsideNextCache,
    baseUrl: SHORTS_API_URL,
  });
  const client = createClient(StockService, transport);
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
