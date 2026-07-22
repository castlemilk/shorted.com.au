import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { NewsService } from "~/gen/shorts/v1alpha1/news_pb";
import { type GetStockNewsResponse } from "~/gen/shorts/v1alpha1/news_pb";
import { cache } from "react";
import { unstable_cache } from "next/cache";
import { SERVER_SHORTS_API_URL, serverFetchOutsideNextCache } from "./config";
import { fetchEdgeReadJson } from "./edgeRead";
import { STOCK_PAGE_CACHE_SECONDS } from "./stockPageCache";
import { withRetryAndNotFound } from "./withRetry";

function createNewsClient() {
  const transport = createConnectTransport({
    fetch: serverFetchOutsideNextCache,
    baseUrl: SERVER_SHORTS_API_URL,
  });
  return createClient(NewsService, transport);
}

export const getStockNews = cache(
  withRetryAndNotFound(
    async (
      stockCode: string,
      limit: number = 20, // eslint-disable-line @typescript-eslint/no-inferrable-types
    ): Promise<GetStockNewsResponse> => {
      const normalizedStockCode = stockCode.trim().toUpperCase();
      const edgeResponse = await fetchEdgeReadJson<GetStockNewsResponse>(
        `/edge/v1/stock/${encodeURIComponent(normalizedStockCode)}/news`,
        { limit },
      );
      if (edgeResponse) return edgeResponse;

      const client = createNewsClient();
      const response = await client.getStockNews({
        stockCode: normalizedStockCode,
        limit,
      });
      return response;
    },
  ),
);

/** Plain, JSON-serializable headline row for server-rendered news lists. */
export interface StockHeadline {
  id: string;
  headline: string;
  url: string;
  source: string;
  /** ISO date string, or null when the article has no timestamp. */
  publishedAtIso: string | null;
}

// publishedAt arrives in two shapes: proto Timestamp objects (bigint
// seconds) from the connect client, and RFC3339 strings from the edge-read
// JSON path. Normalize both to an ISO string.
function toPublishedIso(publishedAt: unknown): string | null {
  if (!publishedAt) return null;
  if (typeof publishedAt === "string") {
    const d = new Date(publishedAt);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof publishedAt === "object" && "seconds" in publishedAt) {
    const seconds = Number(
      (publishedAt as { seconds: bigint | number }).seconds,
    );
    return seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
  }
  return null;
}

/**
 * ISR-safe headlines for the stock page's crawlable news block. The shared
 * getStockNews above is NOT ISR-safe (its connect fallback is forced
 * no-store at Vercel runtime, which throws inside a revalidating route), so
 * this wraps the same edge->connect fetch in unstable_cache and returns a
 * plain serializable shape. Degrades to [] on any failure.
 */
export const getStockHeadlines = cache(
  async (stockCode: string, limit = 5): Promise<StockHeadline[]> => {
    const code = stockCode.trim().toUpperCase();
    try {
      return await unstable_cache(
        async () => {
          const edgeResponse = await fetchEdgeReadJson<GetStockNewsResponse>(
            `/edge/v1/stock/${encodeURIComponent(code)}/news`,
            { limit },
          );
          const response =
            edgeResponse ??
            (await createNewsClient().getStockNews({
              stockCode: code,
              limit,
            }));
          return (response.articles ?? []).slice(0, limit).map((a) => ({
            id: a.id ?? "",
            headline: a.headline ?? "",
            url: a.url ?? "",
            source: a.source ?? "",
            publishedAtIso: toPublishedIso(a.publishedAt),
          }));
        },
        ["stock-headlines", code, String(limit)],
        {
          tags: ["shorts-data", `stock-page:${code}`],
          revalidate: STOCK_PAGE_CACHE_SECONDS,
        },
      )();
    } catch (err) {
      console.error(`[getStockHeadlines] failed for ${code}:`, err);
      return [];
    }
  },
);

export const getMarketNews = cache(
  withRetryAndNotFound(
    async (
      limit: number = 50, // eslint-disable-line @typescript-eslint/no-inferrable-types
      priceSensitiveOnly: boolean = false, // eslint-disable-line @typescript-eslint/no-inferrable-types
    ): Promise<GetStockNewsResponse> => {
      const edgeResponse = await fetchEdgeReadJson<GetStockNewsResponse>(
        "/edge/v1/news/market",
        {
          limit,
          priceSensitiveOnly: priceSensitiveOnly ? true : undefined,
        },
      );
      if (edgeResponse) return edgeResponse;

      const client = createNewsClient();
      const response = await client.getMarketNews({
        limit,
        priceSensitiveOnly,
      });
      return response as unknown as GetStockNewsResponse;
    },
  ),
);
