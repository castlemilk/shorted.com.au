import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ScreenerService } from "~/gen/shorts/v1alpha1/screener_pb";
import { type ScreenStocksResponse, type ScreenerFilters, type ScreenerSortField, type SortDirection } from "~/gen/shorts/v1alpha1/screener_pb";
import { cache } from "react";
import { SHORTS_API_URL, serverFetchWithUserAgent } from "./config";
import { withRetryAndNotFound } from "./withRetry";

// Matches the /stocks ISR window (`export const revalidate = 3600`), the only
// route that renders this action from a SERVER component (CompanyDirectory).
const SCREENER_ISR_REVALIDATE_SECONDS = 3600;

// ISR-safe fetch. Without an explicit `next` (or `cache`) option,
// serverFetchWithUserAgent forces `cache: "no-store"` on POSTs at Vercel
// runtime, and a no-store fetch inside an ISR render THROWS
// ("Dynamic server usage: no-store fetch …/ScreenerService/ScreenStocks").
// That made every /stocks regeneration fail — the route could only ever serve
// its KV/route-cache entry, so a frozen cache pinned it stale (prod logs
// 2026-08-21). Passing `next` is the sanctioned fix (see
// createIsrTopShortsClient in getTopShorts.ts, isrHousingFetch in
// getHousing.ts): Next usually cannot key a streamed Connect POST body, so it
// logs a benign "Failed to generate cache key" and skips the data cache — the
// point is that the regeneration COMPLETES instead of throwing. The `next`
// option is inert in the browser, so the client callers (screener page,
// screener widget, /embed/top-shorts) are unaffected.
const isrScreenerFetch: typeof fetch = (input, init) =>
  serverFetchWithUserAgent(input, {
    ...init,
    next: {
      revalidate: SCREENER_ISR_REVALIDATE_SECONDS,
      tags: ["shorts-data"],
    },
  } as RequestInit);

export const screenStocks = cache(
  withRetryAndNotFound(
    async (
      filters?: ScreenerFilters,
      sortField?: ScreenerSortField,
      sortDirection?: SortDirection,
      limit = 50,
      offset = 0,
    ): Promise<ScreenStocksResponse> => {
      const transport = createConnectTransport({
        fetch: isrScreenerFetch,
        baseUrl: SHORTS_API_URL,
      });
      const client = createClient(ScreenerService, transport);
      return await client.screenStocks({
        filters,
        sortField: sortField ?? 0,
        sortDirection: sortDirection ?? 0,
        limit: Number(limit),
        offset: Number(offset),
      });
    },
  ),
);
