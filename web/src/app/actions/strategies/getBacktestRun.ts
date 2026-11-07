import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { unstable_cache } from "next/cache";
import { StrategyService } from "~/gen/shorts/v1alpha1/strategies_pb";
import {
  SHORTS_API_URL,
  serverFetchOutsideNextCache,
  skipForBuild,
} from "../config";
import { mapBacktestRun } from "~/@/lib/strategies/map-backtest";
import type { BacktestRunView } from "~/@/lib/strategies/map-backtest";

// The published canonical backtest run of a strategy's live version (run_id 0),
// for the Backtest tab. `resolution` is "weekly" (the default, one point per ISO
// week) or "daily" (the API serves daily points for windows of 500 sessions or
// fewer, and says which in series_resolution).
//
// A run in any state (published, run_required, running, not_computable) is an
// answer and is cached under `strategy-backtests`. Only a read that failed, or a
// response with no run at all, is refused: it throws, so the cache keeps nothing.

export type BacktestResolution = "weekly" | "daily";
export type BacktestWindowRequest = "since_2019_05" | "since_2023" | "trailing_12m" | "live";

async function fetchBacktestRun(
  strategyId: string,
  resolution: BacktestResolution,
  window: BacktestWindowRequest,
): Promise<BacktestRunView> {
  const transport = createConnectTransport({
    fetch: serverFetchOutsideNextCache,
    baseUrl: SHORTS_API_URL,
  });
  const client = createClient(StrategyService, transport);
  const response = await client.getBacktestRun({
    strategyId,
    runId: BigInt(0),
    resolution,
    window,
  });
  if (!response.run) {
    throw new Error(`GetBacktestRun returned no run for ${strategyId}`);
  }
  return mapBacktestRun(response.run);
}

export async function getBacktestRun(
  strategyId: string,
  resolution: BacktestResolution = "weekly",
  window: BacktestWindowRequest = "since_2019_05",
): Promise<BacktestRunView | null> {
  if (skipForBuild()) return null;
  try {
    return await unstable_cache(
      () => fetchBacktestRun(strategyId, resolution, window),
      [`strategy-backtest-run-v2-${strategyId}-${resolution}-${window}`],
      { tags: ["strategy-backtests"], revalidate: 3600 },
    )();
  } catch (err) {
    console.error(`[getBacktestRun] failed for ${strategyId}:`, err);
    return null;
  }
}
