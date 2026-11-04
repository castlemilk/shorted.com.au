import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { unstable_cache } from "next/cache";
import { StrategyService } from "~/gen/shorts/v1alpha1/strategies_pb";
import {
  SHORTS_API_URL,
  serverFetchOutsideNextCache,
  skipForBuild,
} from "../config";
import { mapStrategyVersionDetail } from "~/@/lib/strategies/map";
import type { StrategyVersionDetailView } from "~/@/lib/strategies/types";

// The live rules version of one strategy, with its parameters, for the Rules
// tab. An empty version hash asks for the live version. Same pattern as
// listStrategyVersions: connect inside unstable_cache, skipped at build, null
// on failure. A response with no version is a broken backend, so it throws and
// stays out of the cache.

async function fetchStrategyVersion(
  strategyId: string,
): Promise<StrategyVersionDetailView> {
  const transport = createConnectTransport({
    fetch: serverFetchOutsideNextCache,
    baseUrl: SHORTS_API_URL,
  });
  const client = createClient(StrategyService, transport);
  const response = await client.getStrategyVersion({ strategyId, versionHash: "" });
  const mapped = response.version
    ? mapStrategyVersionDetail(response.version)
    : null;
  if (!mapped) {
    throw new Error(`GetStrategyVersion returned no live version for ${strategyId}`);
  }
  return mapped;
}

export async function getStrategyVersion(
  strategyId: string,
): Promise<StrategyVersionDetailView | null> {
  if (skipForBuild()) return null;
  try {
    return await unstable_cache(
      () => fetchStrategyVersion(strategyId),
      [`strategy-live-version-${strategyId}-v2`],
      { tags: ["strategy-picks", "strategy-versions"], revalidate: 3600 },
    )();
  } catch (err) {
    console.error(`[getStrategyVersion] failed for ${strategyId}:`, err);
    return null;
  }
}
