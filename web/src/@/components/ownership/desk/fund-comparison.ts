/**
 * The index fund part of the map's coverage line (spec 14.10), from the map's own answer: the
 * files compared and their two ranges, or that the window holds one file per fund and every
 * change is n/a. The map view draws it from the answer the island holds, so a redirected or
 * re-windowed map states the comparison it actually draws, never the default window's.
 */

import type { OwnershipMapPage } from "~/app/actions/ownershipDesk";

/** The as-at range of one side of the fund comparison: one date, or two. */
export function filesRange(from: string, to: string): string {
  return from === to ? from : `${from} to ${to}`;
}

/**
 * The fund part of the coverage line for an answer, or null when the answer carries no comparison
 * (a failed read, or none reported): the view then draws no line rather than a guessed one.
 */
export function fundComparisonLine(
  map: Pick<OwnershipMapPage, "ok" | "fundsCompared" | "startFilesFrom" | "startFilesTo" | "endFilesFrom" | "endFilesTo">,
): string | null {
  if (!map.ok || typeof map.fundsCompared !== "number") return null;
  // No tracked fund has a file in the window at all: there is nothing to compare or to level.
  if (map.endFilesFrom === "") return "No index fund file in the window";
  if (map.fundsCompared === 0) return "One file per fund: changes n/a";
  const funds = map.fundsCompared === 1 ? "1 fund compared" : `${map.fundsCompared.toLocaleString("en-AU")} funds compared`;
  return `${funds}, files ${filesRange(map.startFilesFrom, map.startFilesTo)} against ${filesRange(map.endFilesFrom, map.endFilesTo)}`;
}
