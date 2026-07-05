import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";
import {
  type GetEditorialTakeResponse,
  type ListEditorialTakesResponse,
} from "~/gen/shorts/v1alpha1/shorts_pb";
import { cache } from "react";
import { SERVER_SHORTS_API_URL, serverFetchWithUserAgent } from "./config";
import { withRetryAndNotFound } from "./withRetry";

function createEditorialClient() {
  const transport = createConnectTransport({
    fetch: serverFetchWithUserAgent,
    baseUrl: SERVER_SHORTS_API_URL,
  });
  return createClient(ShortedStocksService, transport);
}

export const getEditorialTake = cache(
  withRetryAndNotFound(
    async (slug: string): Promise<GetEditorialTakeResponse> => {
      const client = createEditorialClient();
      return await client.getEditorialTake({ slug });
    },
  ),
);

export const listEditorialTakes = cache(
  withRetryAndNotFound(
    async (
      limit: number = 20, // eslint-disable-line @typescript-eslint/no-inferrable-types
      offset: number = 0, // eslint-disable-line @typescript-eslint/no-inferrable-types
      stockCode: string = "", // eslint-disable-line @typescript-eslint/no-inferrable-types
    ): Promise<ListEditorialTakesResponse> => {
      const client = createEditorialClient();
      return await client.listEditorialTakes({ limit, offset, stockCode });
    },
  ),
);
