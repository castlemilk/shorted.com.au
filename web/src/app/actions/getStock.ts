import { createConnectTransport } from "@connectrpc/connect-web";
import { createPromiseClient } from "@connectrpc/connect";
import { type PlainMessage, toPlainMessage } from "@bufbuild/protobuf";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_connect";
import { type Stock } from "~/gen/stocks/v1alpha1/stocks_pb";
import { cache } from "react";
import { getAuthorizationHeader } from "./utils";

export const getStock = cache(async (
  productCode: string,
  token?: string,
): Promise<PlainMessage<Stock>> => {
  const authHeader = await getAuthorizationHeader(new Headers(), token);
  const transport = createConnectTransport({
    // All transports accept a custom fetch implementation.
    fetch: (input, init: RequestInit | undefined) => {
      if (init?.headers) {
        const headers = init.headers as Headers;
        headers.set('Authorization', authHeader.get('Authorization') ?? '');
      }
      return fetch(input, init);
    },
    // With Svelte's custom fetch function, we could alternatively\
    // use a relative base URL here.
    baseUrl:
      process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT ??
      "http://localhost:8080",
  });
  const client = createPromiseClient(ShortedStocksService, transport);

  const response = await client.getStock({ productCode });

  return toPlainMessage(response);
});
