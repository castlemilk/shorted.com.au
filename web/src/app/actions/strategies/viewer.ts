"use server";

// The signed-in depth of a strategy's signals list: GetViewerStrategyPicks, which
// is never clamped. It is per-viewer data, so it is read per request and never
// enters a shared cache: this module imports no cache helper of any kind (a guard
// test holds it to that). The Signals tab's ISR page stays anonymous; this action
// is called from its island once the session says a user is signed in.
//
// The list is read once per strategy, in the evaluator's rank order, and the
// island sorts it in the browser with the same comparator the API uses. A sort
// change therefore costs no read.

import { createClient } from "@connectrpc/connect";

import { mapPicksResponse, type MappedPicks } from "~/@/lib/strategies/map";
import type {
  PickRow,
  StatusCountsView,
  StrategyVersionDef,
} from "~/@/lib/strategies/types";
import { StrategyService } from "~/gen/shorts/v1alpha1/strategies_pb";
import { auth } from "~/server/auth";
import { createSignedInTransport } from "../auth-transport";

/** The API's per-request ceiling for GetStrategyPicks and its viewer copy. */
const PAGE_LIMIT = 100;
/**
 * Pages read for one list: 5,000 signals. The universe is about 2,400 stocks, so
 * the bound is only a guard against a reply that never ends; a list that reaches
 * it is reported as unavailable rather than shown cut short.
 */
const MAX_PAGES = 50;
/** Attempts when the pages of one read come from two different snapshots. */
const MAX_SNAPSHOT_ATTEMPTS = 2;

const STRATEGY_ID = /^[a-z0-9-]{1,64}$/;

/**
 * The snapshot the rows were evaluated in. The island draws the rule columns and
 * the provenance from its own page; it shows these rows only when the snapshot
 * matches that page (same rules version, same session).
 */
export interface ViewerSnapshot {
  version?: StrategyVersionDef;
  /** YYYY-MM-DD of the session the picks are as at. */
  sessionDate: string;
  /** YYYY-MM-DD of the latest price in the universe. */
  asOf: string;
  shortReportDate?: string;
  shortAvailableDate?: string;
  stale: boolean;
}

export type ViewerSignalsResult =
  | {
      ok: true;
      /** Every pick in the list, in the evaluator's rank order. */
      rows: PickRow[];
      /** Picks in the whole list. */
      totalCount: number;
      statusCounts: StatusCountsView | null;
      snapshot: ViewerSnapshot;
    }
  | { ok: false; reason: "signed-out" | "unavailable" };

/**
 * One strategy's full signals list for the signed-in viewer, in rank order. An
 * anonymous caller gets "signed-out" without any call to the API.
 */
export async function getSignalsForViewer(input: {
  strategyId: string;
}): Promise<ViewerSignalsResult> {
  const strategyId =
    typeof input?.strategyId === "string" ? input.strategyId : "";
  if (!STRATEGY_ID.test(strategyId))
    return { ok: false, reason: "unavailable" };

  const session = await auth();
  if (!session?.user?.id) return { ok: false, reason: "signed-out" };

  try {
    // Identity only: this read never sends the address or the verification flag.
    const { transport } = await createSignedInTransport({ withEmail: false });
    const client = createClient(StrategyService, transport);

    for (let attempt = 0; attempt < MAX_SNAPSHOT_ATTEMPTS; attempt++) {
      const list = await readAllPages(client, strategyId);
      if (list === "truncated") {
        console.warn(`[getSignalsForViewer] list longer than the read bound`);
        return { ok: false, reason: "unavailable" };
      }
      if (list) return { ok: true, ...list };
      // The pages came from two snapshots (a refresh landed mid-read): read again.
    }
    return { ok: false, reason: "unavailable" };
  } catch (err) {
    console.warn(`[getSignalsForViewer] unavailable for ${strategyId}:`, err);
    return { ok: false, reason: "unavailable" };
  }
}

type PagesClient = {
  getViewerStrategyPicks: (request: {
    strategyId: string;
    limit: number;
    offset: number;
    status: string;
    sortBy: string;
    requireFundamentals: boolean;
  }) => Promise<Parameters<typeof mapPicksResponse>[0]>;
};

type ViewerList = Omit<Extract<ViewerSignalsResult, { ok: true }>, "ok">;

/**
 * Every page of one list, in rank order. Returns null when the pages disagree on
 * the snapshot, and "truncated" when the list is still going after MAX_PAGES.
 */
async function readAllPages(
  client: PagesClient,
  strategyId: string,
): Promise<ViewerList | null | "truncated"> {
  const rows: PickRow[] = [];
  const seen = new Set<string>();
  // The offset the API pages by: the raw rows read so far, duplicates included.
  let offset = 0;
  let totalCount = 0;
  let statusCounts: StatusCountsView | null = null;
  let snapshot: ViewerSnapshot | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const mapped = mapPicksResponse(
      await client.getViewerStrategyPicks({
        strategyId,
        limit: PAGE_LIMIT,
        offset,
        status: "",
        sortBy: "",
        requireFundamentals: false,
      }),
    );
    const current = snapshotOf(mapped);
    if (snapshot === null) snapshot = current;
    else if (!sameSnapshot(snapshot, current)) return null;

    totalCount = mapped.totalCount;
    statusCounts = mapped.statusCounts ?? null;
    for (const row of mapped.picks) {
      // A row seen on an earlier page would be counted twice: keep the first.
      if (seen.has(row.code)) continue;
      seen.add(row.code);
      rows.push(row);
    }
    offset += mapped.picks.length;
    if (mapped.picks.length === 0 || offset >= totalCount) {
      return { rows, totalCount, statusCounts, snapshot };
    }
  }
  return "truncated";
}

function snapshotOf(mapped: MappedPicks): ViewerSnapshot {
  return {
    version: mapped.version,
    sessionDate: mapped.sessionDate ?? "",
    asOf: mapped.asOf,
    shortReportDate: mapped.shortReportDate,
    shortAvailableDate: mapped.shortAvailableDate,
    stale: mapped.stale === true,
  };
}

function sameSnapshot(a: ViewerSnapshot, b: ViewerSnapshot): boolean {
  return (
    a.sessionDate === b.sessionDate &&
    a.asOf === b.asOf &&
    a.version?.rulesHash === b.version?.rulesHash &&
    a.version?.label === b.version?.label
  );
}
