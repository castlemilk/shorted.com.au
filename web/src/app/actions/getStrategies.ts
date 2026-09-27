import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { unstable_cache } from "next/cache";
import { StrategyService } from "~/gen/shorts/v1alpha1/strategies_pb";
import {
  SHORTS_API_URL,
  serverFetchOutsideNextCache,
  skipForBuild,
} from "./config";
import { mapRegime, mapStrategy } from "~/@/lib/strategies/map";
import type { StrategiesResult } from "~/@/lib/strategies/types";

// Every strategy's definition plus the strategy-neutral market regime, for
// the /picks hub. Same pattern as getStrategyPicks / getScanResults: connect
// inside unstable_cache, an SSR-marked transport, skipped at build, null on
// failure so the hub falls back to its registry copy.

export type { StrategiesResult } from "~/@/lib/strategies/types";

async function fetchStrategies(): Promise<StrategiesResult> {
  const transport = createConnectTransport({
    fetch: serverFetchOutsideNextCache,
    baseUrl: SHORTS_API_URL,
  });
  const client = createClient(StrategyService, transport);
  const response = await client.listStrategies({});
  return {
    strategies: (response.strategies ?? []).map(mapStrategy),
    regime: mapRegime(response.regime),
  };
}

export async function getStrategies(): Promise<StrategiesResult | null> {
  if (skipForBuild()) return null;
  try {
    return await unstable_cache(
      async () => {
        const result = await fetchStrategies();
        // A response with no strategies is a broken backend, not an answer:
        // throw so it is a cache miss rather than an hour-long empty hub.
        if (result.strategies.length === 0) {
          throw new Error("ListStrategies returned no strategies");
        }
        return result;
      },
      ["strategies-list-v1"],
      { tags: ["strategy-picks", "strategies-list"], revalidate: 3600 },
    )();
  } catch (err) {
    console.error("[getStrategies] failed:", err);
    return null;
  }
}
