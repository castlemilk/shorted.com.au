import { createConnectTransport } from "@connectrpc/connect-web";
import { createPromiseClient, ConnectError, Code } from "@connectrpc/connect";
import { type PlainMessage, toPlainMessage } from "@bufbuild/protobuf";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_connect";
import { type StockDetails } from "~/gen/stocks/v1alpha1/stocks_pb";
import { cache } from "react";

export const getStockDetails = cache(async (
  productCode: string,
): Promise<PlainMessage<StockDetails> | undefined> => {
  const transport = createConnectTransport({
    // All transports accept a custom fetch implementation.
    fetch,
    // fetch: (input, init: RequestInit | undefined) => {
    //   if (init?.headers) {
    //     const headers = init.headers as Headers;
    //     headers.set("Authorization", authHeader.get("Authorization") ?? "");
    //   }
    //   return fetch(input, init);
    // },
    baseUrl:
      process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT ??
      "http://localhost:8080",
  });
  const client = createPromiseClient(ShortedStocksService, transport);
  try {
    const response = await client.getStockDetails({ productCode });
    return toPlainMessage(response);
  } catch (err) {
    if (err instanceof ConnectError) {
      if (err.code === Code.NotFound) {
        return;
      }
      throw err;
    }
  }
});
