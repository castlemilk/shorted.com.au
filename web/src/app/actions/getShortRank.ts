import {
  buildApiUrl,
  SHORTS_API_URL,
  serverFetchOutsideNextCache,
} from "./config";
import { sharedRead } from "./shared-read";
import { STOCK_PAGE_CACHE_SECONDS } from "./stockPageCache";

export interface ShortRank {
  rank: number;
  total: number;
}

/**
 * The summary-only top-shorts list every stock's short-interest page ranks
 * against. The request is the same for every code, so it is read once and held
 * for STOCK_PAGE_CACHE_SECONDS in one shared entry (sharedRead). A failed or
 * empty answer throws, so the next page asks again instead of holding an empty
 * list for a day.
 *
 * Not a `next` option on the request: that would store each response in Next's
 * data cache for the window, so one empty answer would reach every stock's page
 * (see applyRoutePolicy in config.ts).
 */
async function fetchRankUniverse(): Promise<string[]> {
  // trim + headers: Vercel env vars can carry trailing newlines, and the
  // Cloudflare WAF in front of api.shorted.com.au serves an HTML 500 to
  // fetches without a UA and Connect-Protocol-Version header.
  const response = await serverFetchOutsideNextCache(
    buildApiUrl(
      SHORTS_API_URL,
      "/shorts.v1alpha1.ShortedStocksService/GetTopShorts",
    ),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
      },
      body: JSON.stringify({
        period: "max",
        limit: 1000,
        offset: 0,
        summaryOnly: true,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`GetTopShorts returned ${response.status}`);
  }
  const data = (await response.json()) as {
    timeSeries?: Array<{ productCode?: string }>;
  };
  const codes = (data.timeSeries ?? []).map((t) => t.productCode ?? "");
  if (codes.length === 0) {
    throw new Error("GetTopShorts returned no stocks");
  }
  return codes;
}

/**
 * A stock's rank among all shorted ASX equities, or null when it is not on the
 * list or the list cannot be read.
 */
export async function getShortRank(
  stockCode: string,
): Promise<ShortRank | null> {
  try {
    const codes = await sharedRead(
      ["short-interest-rank-universe"],
      STOCK_PAGE_CACHE_SECONDS,
      fetchRankUniverse,
    );
    const index = codes.indexOf(stockCode);
    if (index < 0) return null;
    return { rank: index + 1, total: codes.length };
  } catch {
    return null;
  }
}
