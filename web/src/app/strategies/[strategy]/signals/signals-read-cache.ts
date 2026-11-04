// The signed-in Signals reads, held in this browser tab for a minute. A tab
// switch, a strategy link or Back within the minute draws the list it already
// has instead of paying for the same pages again.
//
// The key carries the signed-in user's id, so a second account in the same tab
// never reads the first one's list, and the session and rules version the page
// is drawing, so a list from another snapshot is never reused. Only the signed-in
// island reads this module; the server caches nothing per viewer.

import {
  getSignalsForViewer,
  type ViewerSignalsResult,
} from "~/app/actions/strategies/viewer";

/** How long a viewer's read is reused without a new call. */
export const VIEWER_READ_TTL_MS = 60_000;

export interface ViewerReadKey {
  userId: string;
  strategyId: string;
  sessionDate: string;
  rulesHash: string;
  /** False: the first page. True: the whole list. */
  full: boolean;
}

interface Entry {
  at: number;
  read: Promise<ViewerSignalsResult>;
}

const reads = new Map<string, Entry>();

/**
 * The viewer's read for a key: the in-flight or landed answer while it is fresh,
 * otherwise a new call. A read that failed for a reason other than the session
 * is dropped, so the next mount asks again.
 */
export function readSignalsOnce(
  key: ViewerReadKey,
): Promise<ViewerSignalsResult> {
  const id = JSON.stringify([
    key.userId,
    key.strategyId,
    key.sessionDate,
    key.rulesHash,
    key.full,
  ]);
  const now = Date.now();
  for (const [stale, entry] of reads) {
    if (now - entry.at >= VIEWER_READ_TTL_MS) reads.delete(stale);
  }
  const hit = reads.get(id);
  if (hit) return hit.read;

  const read = getSignalsForViewer({
    strategyId: key.strategyId,
    sessionDate: key.sessionDate,
    rulesHash: key.rulesHash,
    full: key.full,
  }).catch((): ViewerSignalsResult => ({ ok: false, reason: "unavailable" }));
  const entry: Entry = { at: now, read };
  reads.set(id, entry);
  void read.then((result) => {
    if (
      !result.ok &&
      result.reason === "unavailable" &&
      reads.get(id) === entry
    ) {
      reads.delete(id);
    }
  });
  return read;
}

/** Drops every held read. For tests only. */
export function clearSignalsReadCache(): void {
  reads.clear();
}
