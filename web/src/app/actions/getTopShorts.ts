import { createConnectTransport } from "@connectrpc/connect-web";
import { createPromiseClient } from "@connectrpc/connect";
import { toPlainMessage } from "@bufbuild/protobuf";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_connect";
import { cache } from "react";
import { formatPeriodForAPI } from "~/lib/period-utils";
import { SHORTS_API_URL } from "./config";

// Create a cached fetch function that uses Next.js's Data Cache
// This enables Vercel's CDN to serve stale data while revalidating (stale-while-revalidate)
const cachedFetch: typeof fetch = (input, init) => {
  return fetch(input, {
    ...init,
    next: {
      // Cache for 60 seconds, then revalidate in the background
      revalidate: 60,
      // Tag this cache entry so we can manually revalidate if needed
      tags: ['top-shorts'],
    },
  });
};

export const getTopShortsData = cache(
  async (period: string, limit: number, offset: number) => {
    const transport = createConnectTransport({
      // Use the cached fetch function to enable Next.js Data Cache
      fetch: cachedFetch,
      baseUrl:
        process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT ??
        SHORTS_API_URL,
    });

    const client = createPromiseClient(ShortedStocksService, transport);
    const response = await client.getTopShorts({
      period: formatPeriodForAPI(period),
      limit,
      offset,
    });
    return toPlainMessage(response);
  },
);
