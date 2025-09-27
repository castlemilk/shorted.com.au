import { createConnectTransport } from "@connectrpc/connect-web";
import { createPromiseClient } from "@connectrpc/connect";
import { type PlainMessage, toPlainMessage } from "@bufbuild/protobuf";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_connect";
import { type IndustryTreeMap } from "~/gen/stocks/v1alpha1/stocks_pb";
import { type ViewMode } from "~/gen/shorts/v1alpha1/shorts_pb";
import { cache } from "react";

export const getIndustryTreeMap = cache(
  async (
    period: string,
    limit: number,
    viewMode: ViewMode,
  ): Promise<PlainMessage<IndustryTreeMap>> => {
    try {
      const transport = createConnectTransport({
        // All transports accept a custom fetch implementation.
        fetch,
      //   fetch: (input, init: RequestInit | undefined) => {
      //     if (init?.headers) {
      //       const headers = init.headers as Headers;
      //       headers.set('Authorization', authHeader.get('Authorization') ?? '');
      //     }
      //     return fetch(input, init);
      //   },
        // With Svelte's custom fetch function, we could alternatively
        // use a relative base URL here.
        baseUrl:
          process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT ??
          "http://localhost:8080",
      });
      const client = createPromiseClient(ShortedStocksService, transport);

      const response = await client.getIndustryTreeMap({
        period,
        limit,
        viewMode,
      });

      return toPlainMessage(response);
    } catch (error) {
      console.warn("Failed to fetch industry tree map data, returning empty response:", error);
      // Return empty data for build/CI scenarios when service is unavailable
      return {
        industries: [],
        stocks: []
      };
    }
  },
);
