import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";
import {
  type GetEditorialTakeResponse,
  type ListEditorialTakesResponse,
} from "~/gen/shorts/v1alpha1/shorts_pb";
import { cache } from "react";
import { SHORTS_API_URL } from "./config";
import { withRetryAndNotFound } from "./withRetry";

export const getEditorialTake = cache(
  withRetryAndNotFound(
    async (slug: string): Promise<GetEditorialTakeResponse> => {
      const transport = createConnectTransport({
        fetch,
        baseUrl: SHORTS_API_URL,
      });
      const client = createClient(ShortedStocksService, transport);
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
      const transport = createConnectTransport({
        fetch,
        baseUrl: SHORTS_API_URL,
      });
      const client = createClient(ShortedStocksService, transport);
      return await client.listEditorialTakes({ limit, offset, stockCode });
    },
  ),
);
