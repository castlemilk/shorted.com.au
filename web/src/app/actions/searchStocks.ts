import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";
import { type SearchStocksResponse } from "~/gen/shorts/v1alpha1/shorts_pb";
import { SHORTS_API_URL } from "./config";
import { retryWithBackoff } from "@/lib/retry";

const RETRY_OPTIONS = {
  maxRetries: 3,
  initialDelayMs: 500,
  maxDelayMs: 5000,
};

/**
 * Search stocks using Connect RPC
 * Uses Algolia on the backend with PostgreSQL fallback
 */
export async function searchStocks(
  query: string,
  limit = 20,
): Promise<SearchStocksResponse | null> {
  if (!query.trim()) {
    return null;
  }

  const transport = createConnectTransport({
    baseUrl: process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT ?? SHORTS_API_URL,
  });

  const client = createClient(ShortedStocksService, transport);

  try {
    const response = await retryWithBackoff(
      () =>
        client.searchStocks({
          query: query.trim(),
          limit,
          includeDetails: false,
        }),
      RETRY_OPTIONS,
    );
    return response;
  } catch (error) {
    console.error(`Error searching stocks for query "${query}":`, error);
    return null;
  }
}

/**
 * Client-side search stocks function for use in React components
 * Uses the same Connect RPC client but without server-side caching
 */
export async function searchStocksClient(
  query: string,
  limit = 20,
): Promise<SearchStocksResponse | null> {
  return searchStocks(query, limit);
}
