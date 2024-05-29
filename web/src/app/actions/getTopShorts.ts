import { createConnectTransport } from "@connectrpc/connect-web";
import { createPromiseClient } from "@connectrpc/connect";
import { toPlainMessage } from "@bufbuild/protobuf";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_connect";
import { getAuthorizationHeader } from "./utils";

export const getTopShortsData = async (
  period: string,
  limit: number,
  offset: number,
  token?: string,
) => {
  const authHeader = await getAuthorizationHeader(new Headers(), token);
  console.log(authHeader, token);
  const transport = createConnectTransport({
    // All transports accept a custom fetch implementation.
    // fetch,
    fetch: (input, init: RequestInit | undefined) => {
      if (init?.headers) {
        const headers = init.headers as Headers;
        headers.set("Authorization", authHeader.get("Authorization") ?? "");
      }
      return fetch(input, init);
    },
    baseUrl:
      process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT ??
      "http://localhost:8080",
  });
  const client = createPromiseClient(ShortedStocksService, transport);
  const response = await client.getTopShorts({ period, limit, offset });

  return toPlainMessage(response);
};
