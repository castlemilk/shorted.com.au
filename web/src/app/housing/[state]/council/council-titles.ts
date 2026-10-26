import type { CouncilSummary } from "~/gen/shorts/v1alpha1/housing_pb";
import { siteConfig } from "~/@/config/site";
import { councilTitle } from "~/@/lib/housing/council-page";
import { STATE_NAMES } from "~/@/lib/housing/states";

/**
 * The longest title a results page shows in full, counting the " | Shorted"
 * the root template appends. Measured 2026-10-21, council pages rendered at
 * 75-87 characters ("Brewarrina, New South Wales: council profile, population,
 * housing and hazards | Shorted"), and four of the state lists at 75-78.
 */
const RENDERED_TITLE_MAX = 65;

/** What is left for a council title once the root template appends the brand. */
const COUNCIL_TITLE_MAX = RENDERED_TITLE_MAX - ` | ${siteConfig.name}`.length;

/** The first candidate that fits, else the last (the shortest). */
function fit(candidates: readonly string[]): string {
  return candidates.find((t) => t.length <= COUNCIL_TITLE_MAX) ?? candidates[candidates.length - 1]!;
}

/**
 * One council's title, leading with the place and the word "council": "Casey
 * council, VIC: population, housing and hazards". The state is named in full
 * only where it fits ("Knox council, Victoria: ..."); the description always
 * names it. A long name drops to fewer topics, then to the place and state
 * alone, and never to less: seven names (Bayside, Campbelltown, Kingston...)
 * are councils in two states. An unincorporated area is no council, and its
 * ABS name ("Unincorporated NSW") already names its state.
 */
export function councilPageTitle(
  summary: Pick<CouncilSummary, "displayName" | "kind">,
  stateCode: string,
): string {
  const place = councilTitle(summary);
  if (summary.kind !== "council") {
    return fit([
      `${place}: population, housing and hazards`,
      `${place}: population and housing`,
      `${place}: population`,
      place,
    ]);
  }
  const stateName = STATE_NAMES[stateCode] ?? stateCode;
  return fit([
    `${place}, ${stateName}: population, housing and hazards`,
    `${place}, ${stateCode}: population, housing and hazards`,
    `${place}, ${stateCode}: population and housing`,
    `${place}, ${stateCode}: population`,
    `${place}, ${stateCode}`,
  ]);
}

/**
 * A state's council list: "Victoria councils: population, housing and
 * hazards", or "NSW councils: ..." where the state's name does not fit. The
 * description names the state in full, and the grants the list also carries.
 */
export function councilIndexTitle(stateCode: string): string {
  if (stateCode === "ACT") return "ACT local government: the territory as one area";
  const name = STATE_NAMES[stateCode] ?? stateCode;
  return fit([
    `${name} councils: population, housing and hazards`,
    `${stateCode} councils: population, housing and hazards`,
  ]);
}
