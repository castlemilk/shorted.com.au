"use server";

// The public data status of the strategy picks: the latest price session, the
// daily snapshot and the newest ASIC short-position reports with their derived
// availability. "View source dates" reads it on demand, so it is a server action
// the popover calls once it opens, not a read the Signals page makes on every
// regeneration. The answer is the same for every caller, so it is cached for
// the route's window and shared, and a failed or empty answer is never cached.

import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { unstable_cache } from "next/cache";

import { StrategyService } from "~/gen/shorts/v1alpha1/strategies_pb";
import { mapStrategyDataStatus } from "~/@/lib/strategies/map";
import type { StrategyDataStatusView } from "~/@/lib/strategies/types";
import {
  SHORTS_API_URL,
  serverFetchOutsideNextCache,
  skipForBuild,
} from "../config";

async function fetchStrategyDataStatus(): Promise<StrategyDataStatusView> {
  const transport = createConnectTransport({
    fetch: serverFetchOutsideNextCache,
    baseUrl: SHORTS_API_URL,
  });
  const client = createClient(StrategyService, transport);
  const response = await client.getStrategyDataStatus({});
  const status = mapStrategyDataStatus(response);
  // A status with no session and no snapshot is a broken read, not a fact:
  // it throws so the cache keeps nothing.
  if (!status.latestSession && !status.snapshotAsOf) {
    throw new Error("GetStrategyDataStatus returned no session");
  }
  return status;
}

export async function getStrategyDataStatus(): Promise<StrategyDataStatusView | null> {
  if (skipForBuild()) return null;
  try {
    return await unstable_cache(
      fetchStrategyDataStatus,
      ["strategy-data-status-v1"],
      { tags: ["strategy-picks", "strategy-data-status"], revalidate: 600 },
    )();
  } catch (err) {
    console.error("[getStrategyDataStatus] failed:", err);
    return null;
  }
}
