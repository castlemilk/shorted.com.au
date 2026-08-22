import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { NewsService } from "~/gen/shorts/v1alpha1/news_pb";
import { type GetEditorialTakeResponse, type ListEditorialTakesResponse } from "~/gen/shorts/v1alpha1/news_pb";
import { cache } from "react";
import { SERVER_SHORTS_API_URL, serverFetchWithUserAgent } from "./config";
import { withRetryAndNotFound } from "./withRetry";

// ISR-safe fetch — same bug class as screenStocks.ts: with no explicit `next`
// (or `cache`) option, serverFetchWithUserAgent forces `cache: "no-store"` on
// POSTs at Vercel runtime, and a no-store fetch inside an ISR render throws
// "Dynamic server usage: no-store fetch". These takes are rendered server-side
// by /news/[slug] (`revalidate = 600`) and the /news index cards, so every
// regeneration of those routes was failing on the fetch. 600s matches the
// tightest consuming route; Next usually can't key a streamed Connect POST
// body ("Failed to generate cache key" — benign), the point is the regen
// completes instead of throwing.
const isrEditorialFetch: typeof fetch = (input, init) =>
  serverFetchWithUserAgent(input, {
    ...init,
    next: { revalidate: 600, tags: ["shorts-data"] },
  } as RequestInit);

function createEditorialClient() {
  const transport = createConnectTransport({
    fetch: isrEditorialFetch,
    baseUrl: SERVER_SHORTS_API_URL,
  });
  return createClient(NewsService, transport);
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
