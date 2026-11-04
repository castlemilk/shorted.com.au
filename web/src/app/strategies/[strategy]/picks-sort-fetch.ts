// The sort island's network half (docs/plans/fundamentals-coverage.md §7.2),
// loaded with import() on first use so neither it nor the mapper is in the
// page's first-load JavaScript. It answers a status filter as well as a sort:
// the island carries only the shortlist, so the rest of a status is the
// API's to send.
//
// A PLAIN JSON POST, deliberately: the Connect protocol's unary JSON form is
// just that, so the browser needs neither ~/gen (the protobuf descriptors) nor
// @connectrpc. It goes to the same-origin path that web/next.config.mjs
// rewrites to the shorts API (the regex rule for every shorts.v1alpha1
// service), where web/src/middleware.ts stamps the first-party marker. The
// JSON it gets back is protojson, which the ONE mapper (lib/strategies/map.ts)
// reads exactly as it reads the server action's messages.

import {
  mapPicksResponse,
  type StrategyPicksResponseInput,
} from "~/@/lib/strategies/map";
import {
  isRankOrder,
  sortPickRows,
  type PickSortKey,
  type SortedPicks,
} from "~/@/lib/strategies/sort";
import type { PickStatus } from "~/@/lib/strategies/types";

/** Same-origin Connect path, proxied to the API by the next.config.mjs rewrite. */
export const GET_STRATEGY_PICKS_PATH =
  "/shorts.v1alpha1.StrategyService/GetStrategyPicks";

/** The API's GetStrategyPicks ceiling, and the most the sorted table shows. */
export const SORTED_PICKS_LIMIT = 100;

export interface SortedPicksRequest {
  strategyId: string;
  /** Null asks for the default rank order (a status filter alone). */
  sortBy: PickSortKey | null;
  status: PickStatus | null;
  signal?: AbortSignal;
}

/** The request body, exactly: {strategyId, sortBy, status, limit: 100}. */
export function sortedPicksBody(request: SortedPicksRequest): string {
  return JSON.stringify({
    strategyId: request.strategyId,
    sortBy: request.sortBy ?? "",
    status: request.status ?? "",
    limit: SORTED_PICKS_LIMIT,
  });
}

/**
 * One strategy's picks within a status, sorted by the API (or in its rank
 * order when `sortBy` is null). Throws on any non-200 (and on an abort), and
 * the island keeps the server rows.
 *
 * An API that predates sort_by ignores it (Connect discards unknown JSON
 * fields) and answers in rank order; such an API also predates
 * StrategyPick.fundamentals. Only then are the loaded rows sorted here, with
 * the comparator that mirrors the API's own.
 */
export async function fetchSortedPicks(
  request: SortedPicksRequest,
): Promise<SortedPicks> {
  const response = await fetch(GET_STRATEGY_PICKS_PATH, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
    },
    body: sortedPicksBody(request),
    credentials: "same-origin",
    signal: request.signal,
  });
  if (!response.ok) {
    throw new Error(`GetStrategyPicks answered HTTP ${response.status}`);
  }
  const body = (await response.json()) as StrategyPicksResponseInput;
  const mapped = mapPicksResponse(body ?? {});
  const olderApi =
    mapped.fundamentalsRowsCount === 0 &&
    !mapped.picks.some((row) => row.fundamentals !== undefined);
  const clientSorted =
    request.sortBy !== null &&
    olderApi &&
    mapped.picks.length > 1 &&
    isRankOrder(mapped.picks);
  return {
    rows: clientSorted
      ? sortPickRows(mapped.picks, request.sortBy!)
      : mapped.picks,
    totalCount: Math.max(mapped.totalCount, mapped.picks.length),
    clientSorted,
  };
}
