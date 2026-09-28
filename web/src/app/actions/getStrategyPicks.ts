import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { unstable_cache } from "next/cache";
import { StrategyService } from "~/gen/shorts/v1alpha1/strategies_pb";
import {
  SHORTS_API_URL,
  serverFetchOutsideNextCache,
  skipForBuild,
} from "./config";
import {
  mapPicksResponse,
  mapRegime,
  mapStrategy,
} from "~/@/lib/strategies/map";
import type { StrategyPicksResult } from "~/@/lib/strategies/types";

// One strategy's ranked picks for /picks/[strategy] and the /picks hub cards.
//
// The getScanResults pattern exactly: the connect call runs inside
// unstable_cache on a serverFetchOutsideNextCache transport (a bare connect
// POST is forced no-store at Vercel runtime, which THROWS inside a
// revalidating route), build prerenders skip the fetch, and failure degrades
// to null so the page renders its static copy instead of 500ing.
//
// The hub and the strategy page ask for the SAME request (limit 100, no
// status filter, the default rank order) under the same key, so they share
// one cache entry per strategy. The status filter runs client-side over these
// rows; a sort is the page's client island asking the API itself, through the
// SAME mapper (lib/strategies/map.ts), which is why the mapper's input is
// structural rather than the generated message type.
//
// Cache key v2: PickRow gained `fundamentals` and the result gained
// fundamentalsRowsCount (docs/plans/fundamentals-coverage.md §7.2). A v1 entry
// has neither, and would render every row as "No fundamentals held".

export type { StrategyPicksResult } from "~/@/lib/strategies/types";

/** The API's GetStrategyPicks ceiling. */
export const STRATEGY_PICKS_ROW_LIMIT = 100;

async function fetchStrategyPicks(id: string): Promise<StrategyPicksResult | null> {
  const transport = createConnectTransport({
    fetch: serverFetchOutsideNextCache,
    baseUrl: SHORTS_API_URL,
  });
  const client = createClient(StrategyService, transport);
  const response = await client.getStrategyPicks({
    strategyId: id,
    limit: STRATEGY_PICKS_ROW_LIMIT,
    offset: 0,
    status: "",
  });
  if (!response.strategy) return null;
  return {
    strategy: mapStrategy(response.strategy),
    regime: mapRegime(response.regime),
    ...mapPicksResponse(response),
  };
}

export async function getStrategyPicks(
  id: string,
): Promise<StrategyPicksResult | null> {
  if (skipForBuild()) return null;
  try {
    return await unstable_cache(
      async () => {
        const result = await fetchStrategyPicks(id);
        // Never CACHE a data-less result: an empty universe (views not yet
        // refreshed, or a cold database) has no price date. Throwing makes it
        // a cache miss so the next request retries instead of pinning an
        // empty table for an hour.
        if (!result?.asOf) {
          throw new Error("strategy picks returned no price date");
        }
        return result;
      },
      [`strategy-picks-${id}-v2`],
      { tags: ["strategy-picks", `strategy-${id}`], revalidate: 3600 },
    )();
  } catch (err) {
    console.error(`[getStrategyPicks] failed for ${id}:`, err);
    return null;
  }
}
