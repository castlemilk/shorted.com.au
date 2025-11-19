import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";
import { type Stock } from "~/gen/stocks/v1alpha1/stocks_pb";
import { cache } from "react";
import { SHORTS_API_URL } from "./config";

export const getStock = cache(async (
  productCode: string,
): Promise<Stock> => {
  const transport = createConnectTransport({
    // All transports accept a custom fetch implementation.
    fetch,
    // fetch: (input, init: RequestInit | undefined) => {
    //   if (init?.headers) {
    //     const headers = init.headers as Headers;
    //     headers.set('Authorization', authHeader.get('Authorization') ?? '');
    //   }
    //   return fetch(input, init);
    // },
    // With Svelte's custom fetch function, we could alternatively\
    // use a relative base URL here.
    baseUrl: SHORTS_API_URL,
  });
  const client = createClient(ShortedStocksService, transport);

  const response = await client.getStock({ productCode });

  return response;
});
