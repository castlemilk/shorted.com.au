import { createConnectTransport } from "@connectrpc/connect-web";
import { createPromiseClient } from "@connectrpc/connect";
import { type PlainMessage, toPlainMessage } from "@bufbuild/protobuf";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_connect";
import { type TimeSeriesData } from "~/gen/stocks/v1alpha1/stocks_pb";
import { cache } from "react";
import { SHORTS_API_URL } from "./config";
import { formatPeriodForAPI } from "~/lib/period-utils";

// Create a cached fetch function that uses Next.js's Data Cache
// This enables Vercel's CDN to serve stale data while revalidating (stale-while-revalidate)
const cachedFetch: typeof fetch = (input, init) => {
  // Add timeout to prevent hanging requests
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 second timeout

  return fetch(input, {
    ...init,
    signal: controller.signal,
    next: {
      // Cache for 60 seconds, then revalidate in the background
      revalidate: 60,
      // Tag this cache entry so we can manually revalidate if needed
      tags: ["stock-data"],
    },
  }).finally(() => clearTimeout(timeoutId));
};

export const getStockData = cache(
  async (
    productCode: string,
    period: string,
  ): Promise<PlainMessage<TimeSeriesData>> => {
    const transport = createConnectTransport({
      // Use the cached fetch function to enable Next.js Data Cache
      fetch: cachedFetch,
      baseUrl:
        process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT ?? SHORTS_API_URL,
    });
    const client = createPromiseClient(ShortedStocksService, transport);
    const response = await client.getStockData({
      productCode,
      period: formatPeriodForAPI(period),
    });
    return toPlainMessage(response);
  },
);
