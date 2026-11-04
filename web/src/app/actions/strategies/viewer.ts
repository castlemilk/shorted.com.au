"use server";

// The signed-in depth of a strategy's signals list: GetViewerStrategyPicks, which
// is never clamped. It is per-viewer data, so it is read per request and never
// enters a shared cache: no unstable_cache, no KV helper, no route cache tag. The
// Signals tab's ISR page stays anonymous; this action is called from its island
// once the session says a user is signed in.

import { createClient } from "@connectrpc/connect";

import { mapPicksResponse } from "~/@/lib/strategies/map";
import { PICK_SORTS, type PickSortKey } from "~/@/lib/strategies/sort";
import type { PickRow, StatusCountsView } from "~/@/lib/strategies/types";
import { StrategyService } from "~/gen/shorts/v1alpha1/strategies_pb";
import { auth } from "~/server/auth";
import { createSignedInTransport } from "../auth-transport";

/** The API's per-request ceiling for GetStrategyPicks and its viewer copy. */
const PAGE_LIMIT = 100;
/** Pages read for one list: 1,000 signals, far beyond any strategy's universe. */
const MAX_PAGES = 10;

const STRATEGY_ID = /^[a-z0-9-]{1,64}$/;

export type ViewerSignalsResult =
  | {
      ok: true;
      /** Every pick in the list, ordered by the sort (rank order when none). */
      rows: PickRow[];
      /** Picks in the whole list. */
      totalCount: number;
      statusCounts: StatusCountsView | null;
    }
  | { ok: false; reason: "signed-out" | "unavailable" };

/**
 * One strategy's full signals list for the signed-in viewer. The sort is the
 * API's sort_by (empty for the rank order). An anonymous caller gets
 * "signed-out" without any call to the API.
 */
export async function getSignalsForViewer(input: {
  strategyId: string;
  sortBy?: PickSortKey | "";
}): Promise<ViewerSignalsResult> {
  const strategyId = typeof input?.strategyId === "string" ? input.strategyId : "";
  if (!STRATEGY_ID.test(strategyId)) return { ok: false, reason: "unavailable" };
  const sortBy = input.sortBy ?? "";
  if (sortBy !== "" && !PICK_SORTS.some((sort) => sort.key === sortBy)) {
    return { ok: false, reason: "unavailable" };
  }

  const session = await auth();
  if (!session?.user?.id) return { ok: false, reason: "signed-out" };

  try {
    // Identity only: this read never sends the address or the verification flag.
    const { transport } = await createSignedInTransport(session, {
      withEmail: false,
    });
    const client = createClient(StrategyService, transport);

    const rows: PickRow[] = [];
    let totalCount = 0;
    let statusCounts: StatusCountsView | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const response = await client.getViewerStrategyPicks({
        strategyId,
        limit: PAGE_LIMIT,
        offset: rows.length,
        status: "",
        sortBy,
        requireFundamentals: false,
      });
      const mapped = mapPicksResponse(response);
      rows.push(...mapped.picks);
      totalCount = mapped.totalCount;
      statusCounts = mapped.statusCounts ?? null;
      if (mapped.picks.length === 0 || rows.length >= totalCount) break;
    }
    return { ok: true, rows, totalCount, statusCounts };
  } catch (err) {
    console.warn(`[getSignalsForViewer] unavailable for ${strategyId}:`, err);
    return { ok: false, reason: "unavailable" };
  }
}
