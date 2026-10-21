import type { CouncilSummary } from "~/gen/shorts/v1alpha1/housing_pb";
import { councilTitle } from "~/@/lib/housing/council-page";
import { STATE_NAMES } from "~/@/lib/housing/states";

/**
 * The longest council title before the root template's " | Shorted", about
 * what a results page shows. Measured 2026-10-21, council pages rendered at
 * 75-87 characters ("Brewarrina, New South Wales: council profile, population,
 * housing and hazards | Shorted"), and four of the state hubs reach 75-78.
 */
export const COUNCIL_TITLE_MAX = 60;

/** The first candidate that fits, else the last (the shortest). */
function fit(candidates: readonly string[]): string {
  return candidates.find((t) => t.length <= COUNCIL_TITLE_MAX) ?? candidates[candidates.length - 1]!;
}

/**
 * One council's title, leading with the place and the word "council": "Casey
 * council, Victoria: population, housing and hazards". A long name or state
 * drops to the state code, then to fewer topics. An unincorporated area is no
 * council, and its ABS name ("Unincorporated NSW") already names its state.
 */
export function councilPageTitle(
  summary: Pick<CouncilSummary, "displayName" | "kind">,
  stateCode: string,
): string {
  const place = councilTitle(summary);
  if (summary.kind !== "council") {
    return fit([`${place}: population, housing and hazards`, `${place}: population and housing`, place]);
  }
  const stateName = STATE_NAMES[stateCode] ?? stateCode;
  return fit([
    `${place}, ${stateName}: population, housing and hazards`,
    `${place}, ${stateCode}: population, housing and hazards`,
    `${place}, ${stateCode}: population and housing`,
    `${place}, ${stateCode}`,
  ]);
}

/** A state's council list: "New South Wales councils: population, housing and hazards". */
export function councilIndexTitle(stateCode: string): string {
  if (stateCode === "ACT") return "ACT local government: the territory as one area";
  const name = STATE_NAMES[stateCode] ?? stateCode;
  return fit([
    `${name} councils: population, housing, grants and hazards`,
    `${name} councils: population, housing and hazards`,
  ]);
}
