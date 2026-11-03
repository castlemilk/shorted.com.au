import { getServerShortsApiUrl, serverFetchOutsideNextCache } from "./config";
import { sharedRead } from "./shared-read";

// The report OG images held this read for a day before, through the fetch's
// `next: { revalidate: 86400 }`.
const MARKET_BY_DATE_REVALIDATE_SECONDS = 86400;

/** The fields the report OG images read from a GetMarketByDate answer. */
export interface MarketByDateAnswer {
  stocks?: Array<{
    productCode?: string;
    name?: string;
    percentageShorted?: number;
  }>;
  previousDate?: string;
}

/**
 * One GetMarketByDate answer for a date (its top stock, or the previous date
 * when the day has none), shared for a day through sharedRead. The report OG
 * images are dynamic routes, so a route's `revalidate` holds nothing here. The
 * read carries no fetch-level `next` option, so Next's data cache holds nothing
 * either: the shared entry is the only cache, and every image and request for
 * that date makes one call.
 *
 * A failed answer, and one with neither stocks nor a previousDate, throw, so
 * neither is held and the next request asks again.
 */
export function marketByDateShared(date: string): Promise<MarketByDateAnswer> {
  return sharedRead(
    ["market-by-date", date, "1", "0", "og-v1"],
    MARKET_BY_DATE_REVALIDATE_SECONDS,
    async () => {
      const response = await serverFetchOutsideNextCache(
        `${getServerShortsApiUrl()}/shorts.v1alpha1.ShortedStocksService/GetMarketByDate`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Connect-Protocol-Version": "1",
            "User-Agent": "shorted-og/1.0",
          },
          body: JSON.stringify({ date, limit: 1, offset: 0 }),
        },
      );
      if (!response.ok) {
        throw new Error(
          `GetMarketByDate ${date}: API returned ${response.status}`,
        );
      }
      const answer = (await response.json()) as MarketByDateAnswer;
      if (!answer.stocks?.length && !answer.previousDate) {
        throw new Error(`GetMarketByDate ${date}: API returned no stocks`);
      }
      return answer;
    },
  );
}
