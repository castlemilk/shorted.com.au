import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";
import { type Stock } from "~/gen/stocks/v1alpha1/stocks_pb";
import { cache } from "react";
import { unstable_cache } from "next/cache";
import { SHORTS_API_URL, serverFetchOutsideNextCache } from "./config";
import { fetchEdgeReadJson } from "./edgeRead";
import { withRetryAndNotFound, withRetryAndThrowNotFound } from "./withRetry";
import {
  STOCK_PAGE_CACHE_SECONDS,
  normalizeStockPageCacheCode,
  stockPageCacheTags,
  toNextDataCacheValue,
} from "./stockPageCache";

async function fetchStock(productCode: string): Promise<Stock> {
  const edgeResponse = await fetchEdgeReadJson<Stock>(
    `/edge/v1/stock/${encodeURIComponent(productCode)}`,
  );
  if (edgeResponse) return edgeResponse;

  const transport = createConnectTransport({
    fetch: serverFetchOutsideNextCache,
    baseUrl: SHORTS_API_URL,
  });
  const client = createClient(ShortedStocksService, transport);
  return client.getStock({ productCode });
}

function getCachedStock(productCode: string): Promise<Stock> {
  const cacheCode = normalizeStockPageCacheCode(productCode);
  return unstable_cache(
    async () => toNextDataCacheValue(await fetchStock(cacheCode)) as Stock,
    ["stock", cacheCode],
    {
      tags: stockPageCacheTags("stock", cacheCode),
      revalidate: STOCK_PAGE_CACHE_SECONDS,
    },
  )();
}

export const getStock = cache(
  withRetryAndNotFound(async (productCode: string): Promise<Stock> => {
    return getCachedStock(productCode);
  }),
);

/**
 * Like getStock but throws NotFoundError when the stock doesn't exist.
 * Returns undefined only for transient backend errors.
 * Used by the stock detail page to trigger Next.js notFound().
 */
export const getStockOrNotFound = cache(
  withRetryAndThrowNotFound(async (productCode: string): Promise<Stock> => {
    return getCachedStock(productCode);
  }),
);
