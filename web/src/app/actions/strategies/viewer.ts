"use server";

// The signed-in depth of a strategy's signals list: GetViewerStrategyPicks, which
// is never clamped. It is per-viewer data, so it is read per request and never
// enters a shared cache: this module imports no cache helper of any kind (a guard
// test holds it to that). The Signals tab's ISR page stays anonymous; this action
// is called from its island once the session says a user is signed in.
//
// A read is either the first page of the evaluator's rank order (the island's
// mount) or the whole list (only when the viewer searches, filters, sorts or
// draws past the first page). Every page of one read must come from the snapshot
// the island is drawing; a page that differs ends the read, and the island does
// not draw the rows. A full read costs one API call per 100 signals, so the
// island asks for it only when it needs it.

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
      /** The rows read, in the evaluator's rank order: the first page or the whole list. */
      rows: PickRow[];
      /** Picks in the whole list. */
      totalCount: number;
      statusCounts: StatusCountsView | null;
      snapshot: ViewerSnapshot;
    }
  | {
      ok: false;
      reason: "signed-out" | "unavailable" | "snapshot-mismatch";
    };

export interface ViewerSignalsInput {
  strategyId: string;
  /**
   * The session and rules version the page is drawing. When both are given, the
   * read stops at the first page that is from another snapshot.
   */
  sessionDate?: string;
  rulesHash?: string;
  /** False (the default) reads the first page only; true reads the whole list. */
  full?: boolean;
}

/**
 * A strategy's signals list for the signed-in viewer, in rank order. An anonymous
 * caller gets "signed-out" without any call to the API.
 */
export async function getSignalsForViewer(
  input: ViewerSignalsInput,
): Promise<ViewerSignalsResult> {
  const strategyId =
    typeof input?.strategyId === "string" ? input.strategyId : "";
  if (!STRATEGY_ID.test(strategyId))
    return { ok: false, reason: "unavailable" };

  const session = await auth();
  if (!session?.user?.id) return { ok: false, reason: "signed-out" };

  const expect =
    typeof input.sessionDate === "string" && typeof input.rulesHash === "string"
      ? { sessionDate: input.sessionDate, rulesHash: input.rulesHash }
      : null;

  try {
    // Identity only: this read never sends the address or the verification flag.
    const { transport } = await createSignedInTransport({ withEmail: false });
    const client = createClient(StrategyService, transport);

    const list = await readPages(client, strategyId, {
      full: input.full === true,
      expect,
    });
    if (list === "truncated") {
      console.warn(`[getSignalsForViewer] list longer than the read bound`);
      return { ok: false, reason: "unavailable" };
    }
    if (list === "unavailable") return { ok: false, reason: "unavailable" };
    if (list === "mismatch") return { ok: false, reason: "snapshot-mismatch" };
    return { ok: true, ...list };
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

/** One attempt's answer: a list, or why it could not be drawn. */
type Attempt = ViewerList | "mismatch" | "inconsistent" | "truncated";

/**
 * The first page of a list (`full` false), or every page of it (`full` true), in
 * rank order. Returns "mismatch" when a page is from another snapshot than
 * `expect` or than the first page, and "truncated" when a full list is longer
 * than MAX_PAGES.
 *
 * A full list is only drawn when its pages add up: every page carries the same
 * count, no code repeats, and the rows number the count. A page set that does
 * not (the API re-ranked between two pages of one snapshot) is read again once
 * from the start. A second inconsistent read answers "unavailable": a short
 * list is never drawn as the whole list.
 */
async function readPages(
  client: PagesClient,
  strategyId: string,
  options: {
    full: boolean;
    expect: { sessionDate: string; rulesHash: string } | null;
  },
): Promise<ViewerList | "mismatch" | "truncated" | "unavailable"> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await readAttempt(client, strategyId, options);
    if (result !== "inconsistent") return result;
  }
  return "unavailable";
}

async function readAttempt(
  client: PagesClient,
  strategyId: string,
  options: {
    full: boolean;
    expect: { sessionDate: string; rulesHash: string } | null;
  },
): Promise<Attempt> {
  const first = await fetchPage(client, strategyId, 0);
  const snapshot = snapshotOf(first);
  if (options.expect && !matchesExpected(snapshot, options.expect))
    return "mismatch";

  const pages: MappedPicks[] = [first];
  if (options.full) {
    const needed = Math.ceil(first.totalCount / PAGE_LIMIT);
    if (needed > MAX_PAGES) return "truncated";
    // The pages after the first are read together, so a whole list takes one
    // round trip rather than one per page: the server action that carries it
    // holds the app's one-at-a-time action queue for that long.
    const rest = await Promise.all(
      Array.from({ length: Math.max(0, needed - 1) }, (_, i) =>
        fetchPage(client, strategyId, (i + 1) * PAGE_LIMIT),
      ),
    );
    pages.push(...rest);
  }

  const rows: PickRow[] = [];
  const seen = new Set<string>();
  let inconsistent = false;
  for (const [index, page] of pages.entries()) {
    if (index > 0 && !sameSnapshot(snapshot, snapshotOf(page)))
      return "mismatch";
    if (page.totalCount !== first.totalCount) inconsistent = true;
    for (const row of page.picks) {
      if (seen.has(row.code)) {
        inconsistent = true;
        continue;
      }
      seen.add(row.code);
      rows.push(row);
    }
  }
  if (options.full && rows.length !== first.totalCount) inconsistent = true;
  if (inconsistent) return "inconsistent";

  return {
    rows,
    totalCount: first.totalCount,
    statusCounts: first.statusCounts ?? null,
    snapshot,
  };
}

function fetchPage(
  client: PagesClient,
  strategyId: string,
  offset: number,
): Promise<MappedPicks> {
  return client
    .getViewerStrategyPicks({
      strategyId,
      limit: PAGE_LIMIT,
      offset,
      status: "",
      sortBy: "",
      requireFundamentals: false,
    })
    .then(mapPicksResponse);
}

function matchesExpected(
  snapshot: ViewerSnapshot,
  expect: { sessionDate: string; rulesHash: string },
): boolean {
  return (
    snapshot.sessionDate === expect.sessionDate &&
    (snapshot.version?.rulesHash ?? "") === expect.rulesHash
  );
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
