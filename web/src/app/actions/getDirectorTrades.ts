import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { StockService } from "~/gen/shorts/v1alpha1/stock_pb";
import { type GetDirectorTradesResponse } from "~/gen/shorts/v1alpha1/stock_pb";
import { cache } from "react";
import { SHORTS_API_URL, serverFetchWithUserAgent } from "./config";
import { stockPageCacheTags } from "./stockPageCache";
import { withRetryAndNotFound } from "./withRetry";

// ISR-safe fetch — same bug class as screenStocks.ts: with no explicit `next`
// (or `cache`) option, serverFetchWithUserAgent forces `cache: "no-store"` on
// POSTs at Vercel runtime, and a no-store fetch inside an ISR render throws
// "Dynamic server usage: no-store fetch". Its callers are
// /insider-trading/[stockCode] and the stock page's Company tab (both
// `export const revalidate = 3600`), whose regeneration therefore could never
// fetch. Next generally can't key a streamed Connect POST body, so it logs a
// benign "Failed to generate cache key" and skips the data cache — the point is
// the regen completes. The policy's tags are the stock's own, so a sync that
// did not write this stock leaves its Company tab alone; the fetch is written
// inline because serverApiSurface.test.ts reads each transport's policy from
// its source.

export const getDirectorTrades = cache(
  withRetryAndNotFound(
    async (
      stockCode: string,
      limit: number = 20, // eslint-disable-line @typescript-eslint/no-inferrable-types
    ): Promise<GetDirectorTradesResponse> => {
      const tags = stockPageCacheTags("director-trades", stockCode);
      const transport = createConnectTransport({
        fetch: (input, init) =>
          serverFetchWithUserAgent(input, {
            ...init,
            next: { revalidate: 3600, tags },
          } as RequestInit),
        baseUrl: SHORTS_API_URL,
      });
      const client = createClient(StockService, transport);
      const response = await client.getDirectorTrades({ stockCode, limit });
      return response;
    },
  ),
);
