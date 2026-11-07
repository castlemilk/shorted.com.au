import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { unstable_cache } from "next/cache";
import { MarketService } from "~/gen/shorts/v1alpha1/market_pb";
import { isValidStockCode } from "~/@/lib/stock-code";
import {
  toMarketMoveViews,
  type MarketMoveView,
} from "~/@/lib/market-moves/view";
import {
  SERVER_SHORTS_API_URL,
  serverFetchOutsideNextCache,
  skipForBuild,
} from "../config";

// The three server reads of MarketService.ListMarketMoves: the /market-moves
// feed, the homepage strip and a stock page's card.
//
// Contract, all of it load-bearing (getStockRegisterStrip's, with its own keys):
//   - each read is an unstable_cache entry under its own tag, the tag the API
//     revalidates after a move changes (services/shorts/internal/services/
//     shorts/market_moves_revalidate.go): "market-moves" (the feed),
//     "market-moves:home" (the strip) and "market-moves:stock:<CODE>";
//   - each entry's revalidate is its page's own window, never shorter: a route's
//     revalidate is the lowest any read in it asks for, so a 300 s entry would
//     turn the 24-hour homepage into a five-minute one. The API's ping, not the
//     window, is what brings a new move in;
//   - a serverFetchOutsideNextCache transport with a 4 s abort, so a slow API
//     costs the moves, never the render;
//   - errors are thrown INSIDE the cached function, so nothing failed is ever
//     cached; the wrapper below catches and degrades (the feed to undefined, so
//     its page can say the moves are unavailable rather than that none exist;
//     the strip and the card to [], which hides them);
//   - only plain MarketMoveView objects enter the cache, never protobuf messages.

/** Abort the RPC after this long: the moves are optional, the render is not. */
export const MARKET_MOVES_TIMEOUT_MS = 4000;

/** The cache version of every market-moves entry. */
export const MARKET_MOVES_CACHE_VERSION = "v1";

export const MARKET_MOVES_FEED_LIMIT = 50;
export const MARKET_MOVES_HOME_LIMIT = 4;
export const MARKET_MOVES_HOME_MIN_SIGNIFICANCE = 3;
export const MARKET_MOVES_STOCK_LIMIT = 5;

/** The /market-moves page's window (its `revalidate` export matches). */
export const MARKET_MOVES_FEED_REVALIDATE_SECONDS = 300;
/** The homepage's window (app/page.tsx). */
export const MARKET_MOVES_HOME_REVALIDATE_SECONDS = 86400;
/** A stock page's window (app/shorts/[stockCode]/page.tsx). */
export const MARKET_MOVES_STOCK_REVALIDATE_SECONDS = 3600;

export const MARKET_MOVES_FEED_TAG = "market-moves";
export const MARKET_MOVES_HOME_TAG = "market-moves:home";
export function marketMovesStockTag(code: string): string {
  return `market-moves:stock:${code}`;
}

interface ListMarketMovesQuery {
  stockCode?: string;
  minSignificance?: number;
  limit: number;
}

function marketClient() {
  const transport = createConnectTransport({
    fetch: serverFetchOutsideNextCache,
    baseUrl: SERVER_SHORTS_API_URL,
  });
  return createClient(MarketService, transport);
}

async function fetchMoves(
  query: ListMarketMovesQuery,
): Promise<MarketMoveView[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MARKET_MOVES_TIMEOUT_MS);
  try {
    const response = await marketClient().listMarketMoves(query, {
      signal: controller.signal,
      timeoutMs: MARKET_MOVES_TIMEOUT_MS,
    });
    return toMarketMoveViews(response.moves ?? []);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The /market-moves feed: the newest moves of every kind. undefined when the
 * moves could not be read (a build prerender, a timeout, an API without the
 * rpc); [] is a real answer, that none have been posted.
 */
export async function getMarketMovesFeed(): Promise<
  MarketMoveView[] | undefined
> {
  if (skipForBuild()) return undefined;
  try {
    return await unstable_cache(
      () => fetchMoves({ limit: MARKET_MOVES_FEED_LIMIT }),
      ["market-moves-feed", MARKET_MOVES_CACHE_VERSION],
      {
        revalidate: MARKET_MOVES_FEED_REVALIDATE_SECONDS,
        tags: [MARKET_MOVES_FEED_TAG],
      },
    )();
  } catch (err) {
    console.warn("[market moves] feed unavailable:", err);
    return undefined;
  }
}

/** The homepage strip: the newest moves of significance 3 or more. [] on any failure. */
export async function getHomeMarketMoves(): Promise<MarketMoveView[]> {
  if (skipForBuild()) return [];
  try {
    return await unstable_cache(
      () =>
        fetchMoves({
          minSignificance: MARKET_MOVES_HOME_MIN_SIGNIFICANCE,
          limit: MARKET_MOVES_HOME_LIMIT,
        }),
      ["market-moves-home", MARKET_MOVES_CACHE_VERSION],
      {
        revalidate: MARKET_MOVES_HOME_REVALIDATE_SECONDS,
        tags: [MARKET_MOVES_HOME_TAG],
      },
    )();
  } catch (err) {
    console.warn("[market moves] homepage strip unavailable:", err);
    return [];
  }
}

/**
 * A stock's newest moves: the moves about it and the moves that name it.
 * [] for a code that is not a stock code, and on any failure.
 */
export async function getStockMarketMoves(
  stockCode: string,
): Promise<MarketMoveView[]> {
  if (!isValidStockCode(stockCode)) return [];
  const code = stockCode.trim().toUpperCase();
  if (skipForBuild()) return [];
  try {
    return await unstable_cache(
      () => fetchMoves({ stockCode: code, limit: MARKET_MOVES_STOCK_LIMIT }),
      ["market-moves-stock", code, MARKET_MOVES_CACHE_VERSION],
      {
        revalidate: MARKET_MOVES_STOCK_REVALIDATE_SECONDS,
        tags: [marketMovesStockTag(code)],
      },
    )();
  } catch (err) {
    console.warn(`[market moves] moves unavailable for ${code}:`, err);
    return [];
  }
}
