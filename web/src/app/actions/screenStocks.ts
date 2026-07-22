import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ScreenerService } from "~/gen/shorts/v1alpha1/screener_pb";
import { type ScreenStocksResponse, type ScreenerFilters, type ScreenerSortField, type SortDirection } from "~/gen/shorts/v1alpha1/screener_pb";
import { cache } from "react";
import { SHORTS_API_URL, serverFetchWithUserAgent } from "./config";
import { withRetryAndNotFound } from "./withRetry";

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
        fetch: serverFetchWithUserAgent,
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
