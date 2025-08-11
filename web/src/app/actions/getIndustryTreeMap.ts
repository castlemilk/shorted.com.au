import { createConnectTransport } from "@connectrpc/connect-web";
import { createPromiseClient } from "@connectrpc/connect";
import { type PlainMessage, toPlainMessage } from "@bufbuild/protobuf";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_connect";
import { type IndustryTreeMap } from "~/gen/stocks/v1alpha1/stocks_pb";
import { type ViewMode } from "~/gen/shorts/v1alpha1/shorts_pb";
import { SHORTS_API_URL } from "./config";
import { cache } from "react";
import { formatPeriodForAPI } from "~/lib/period-utils";

export const getIndustryTreeMap = cache(
  async (
    period: string,
    limit: number,
    viewMode: ViewMode,
  ): Promise<PlainMessage<IndustryTreeMap>> => {
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
        SHORTS_API_URL,
    });
    const client = createPromiseClient(ShortedStocksService, transport);

    const response = await client.getIndustryTreeMap({
      period: formatPeriodForAPI(period),
      limit,
      viewMode,
    });

    return toPlainMessage(response);
  },
);
