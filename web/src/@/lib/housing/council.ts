/**
 * Council (LGA) helpers shared by every surface that names a council.
 *
 * Council pages live at /housing/<state>/council/<slug> (program decision 5).
 * They do not exist yet: COUNCIL_PAGES_ENABLED is the single switch the
 * council-hub work flips when the routes ship, so no surface links to a 404
 * in the meantime.
 */
import { STATE_NAMES, stateSlug } from "./states";

export const COUNCIL_PAGES_ENABLED = false;

/**
 * The council page URL, or null when there is no page to link to: pages off,
 * no slug (a pseudo-area, or a council loaded before slugs were minted), or a
 * state without a /housing/<state> route (Other Territories).
 */
export function councilHref(
  stateCode: string,
  slug: string,
  pagesEnabled: boolean = COUNCIL_PAGES_ENABLED,
): string | null {
  if (!pagesEnabled || !slug || !STATE_NAMES[stateCode]) return null;
  return `/housing/${stateSlug(stateCode)}/council/${encodeURIComponent(slug)}`;
}

/**
 * A share of a suburb's residents as a whole percent, never "0%": the bridge
 * keeps every council above 1%, so anything shown is at least 1%.
 */
export function fmtCouncilShare(share: number): string {
  return `${Math.max(1, Math.round(share * 100))}%`;
}
