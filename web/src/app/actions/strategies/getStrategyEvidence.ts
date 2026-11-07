import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { unstable_cache } from "next/cache";
import { StrategyService } from "~/gen/shorts/v1alpha1/strategies_pb";
import {
  SHORTS_API_URL,
  serverFetchOutsideNextCache,
  skipForBuild,
} from "../config";
import { mapStrategyEvidenceList } from "~/@/lib/strategies/map-backtest";
import type { StrategyEvidenceListView } from "~/@/lib/strategies/map-backtest";

// The backtest evidence of every strategy on the live version (ListStrategyEvidence):
// each strategy's state, its chained windows, its annual table, its month-end mini
// curve and its recorded paper track. The same answer to every caller, so it is
// shared for the route's window under the `strategy-backtests` tag, which the
// backtest job revalidates when it publishes.
//
// Same pattern as the other strategy reads: the connect call runs inside
// unstable_cache on the anonymous transport, build prerenders skip it, and a
// failure returns null. An answer with no strategies is a broken read, so it
// throws and the cache keeps nothing.

async function fetchStrategyEvidence(): Promise<StrategyEvidenceListView> {
  const transport = createConnectTransport({
    fetch: serverFetchOutsideNextCache,
    baseUrl: SHORTS_API_URL,
  });
  const client = createClient(StrategyService, transport);
  const response = await client.listStrategyEvidence({});
  const mapped = mapStrategyEvidenceList(response);
  if (mapped.strategies.length === 0) {
    throw new Error("ListStrategyEvidence returned no strategies");
  }
  return mapped;
}

export async function getStrategyEvidence(): Promise<StrategyEvidenceListView | null> {
  if (skipForBuild()) return null;
  try {
    return await unstable_cache(fetchStrategyEvidence, ["strategy-evidence-v2"], {
      tags: ["strategy-backtests", "strategy-picks"],
      revalidate: 3600,
    })();
  } catch (err) {
    console.error("[getStrategyEvidence] failed:", err);
    return null;
  }
}
